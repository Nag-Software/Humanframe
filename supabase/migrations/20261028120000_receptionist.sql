-- ---------------------------------------------------------------------------
-- The receptionist (docs/PIVOT.md).
--
-- A small business forwards the calls it cannot answer to a Humanframe number.
-- The AI answers, learns what the caller needs, and afterwards proposes what
-- should happen: a booking, an SMS with a link, a written reply. The owner
-- approves each proposal with one tap. Nothing reaches the caller or the
-- owner's calendar without that approval.
--
-- Shape of the data:
--
--   business_profiles   what the AI knows about the business, learned from its
--                       website and corrected by the owner
--   phone_numbers       the Humanframe numbers a workspace forwards to
--   inquiries           one per call, voicemail or inbound SMS thread
--   inquiry_actions     the approval queue: proposals, frozen until decided
--   bookings            appointments, ours, mirrored to a calendar if connected
--   sms_messages        every SMS in and out, for threading and the report
--   inquiry_upload_links / inquiry_files
--                       the photo upload page a caller opens from an SMS
--   weekly_reports      what the AI caught that week, sent once
--
-- Reads are open to workspace members. Writes are made by server routes: the
-- webhooks with the service role after verifying the provider's signature,
-- the owner's decisions after resolving their membership from the session.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Business profile
-- ---------------------------------------------------------------------------

create table if not exists public.business_profiles (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,

  name text not null default '',
  website_url text,
  -- Two or three sentences the AI can say about the business.
  summary text not null default '',
  -- [{ "name": "...", "description": "...", "price": "..." }]
  services jsonb not null default '[]'::jsonb,
  -- Free text, because real price lists are not tidy.
  prices text not null default '',
  -- { "mon": [["08:00","16:00"]], ..., "sun": [] } in the profile's timezone.
  opening_hours jsonb not null default '{}'::jsonb,
  address text not null default '',
  service_area text not null default '',
  contact_phone text not null default '',
  contact_email text not null default '',
  -- The page an "info" SMS links to. Defaults to the website.
  info_url text,
  -- [{ "q": "...", "a": "..." }]
  faq jsonb not null default '[]'::jsonb,
  -- The owner's own rules: "never promise a price", "emergencies: call 4xx".
  instructions text not null default '',
  -- Spoken by the phone provider before the AI joins, so the caller hears
  -- someone at once and is told the call is recorded (GDPR art. 13).
  greeting text not null default '',

  -- Where the owner is told about a new inquiry.
  owner_phone text,
  notify_sms boolean not null default true,
  notify_email boolean not null default true,
  -- Alphanumeric sender for outbound SMS, max 11 characters. Null uses the
  -- workspace's own number, which the caller can reply to.
  sms_sender text check (sms_sender is null or sms_sender ~ '^[A-Za-z0-9 ]{1,11}$'),

  booking_enabled boolean not null default true,
  appointment_minutes integer not null default 60
    check (appointment_minutes between 10 and 600),
  buffer_minutes integer not null default 0
    check (buffer_minutes between 0 and 240),
  min_notice_hours integer not null default 2
    check (min_notice_hours between 0 and 336),
  timezone text not null default 'Europe/Oslo',

  -- The secret in the owner's calendar subscription URL. Rotating it is how
  -- a leaked feed is revoked.
  -- Core functions only: on Supabase pgcrypto lives in `extensions`, which
  -- is not on every role's search_path.
  calendar_feed_token text not null
    default substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 48),

  -- What the website crawl read, for the owner to check against.
  learned_from jsonb not null default '[]'::jsonb,
  learned_at timestamptz,
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint business_profiles_feed_token_key unique (calendar_feed_token)
);

drop trigger if exists set_business_profiles_updated_at on public.business_profiles;
create trigger set_business_profiles_updated_at before update on public.business_profiles
  for each row execute function public.set_updated_at();

alter table public.business_profiles enable row level security;

drop policy if exists "members read business profile" on public.business_profiles;
create policy "members read business profile" on public.business_profiles
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "admins write business profile" on public.business_profiles;
create policy "admins write business profile" on public.business_profiles
  for all to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- ---------------------------------------------------------------------------
-- Phone numbers
-- ---------------------------------------------------------------------------

create table if not exists public.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- E.164. Unique across the whole service: an incoming call is routed to a
  -- workspace by the number it was placed to, and nothing else.
  e164 text not null check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  provider text not null default 'twilio' check (provider in ('twilio')),
  provider_sid text,
  -- The business's own number that forwards here, for the setup guide.
  forwarded_from text,
  status text not null default 'active' check (status in ('active', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint phone_numbers_id_workspace_key unique (id, workspace_id)
);

create unique index if not exists phone_numbers_live_e164_idx
  on public.phone_numbers (e164)
  where status = 'active';

create index if not exists phone_numbers_workspace_idx
  on public.phone_numbers (workspace_id);

drop trigger if exists set_phone_numbers_updated_at on public.phone_numbers;
create trigger set_phone_numbers_updated_at before update on public.phone_numbers
  for each row execute function public.set_updated_at();

alter table public.phone_numbers enable row level security;

drop policy if exists "members read phone numbers" on public.phone_numbers;
create policy "members read phone numbers" on public.phone_numbers
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Inquiries
-- ---------------------------------------------------------------------------

create table if not exists public.inquiries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  phone_number_id uuid,

  channel text not null check (channel in ('phone', 'voicemail', 'sms')),
  status text not null default 'open'
    check (status in ('open', 'handled', 'dismissed')),

  caller_phone text,
  caller_name text,
  caller_email text,
  -- One line for the list, a paragraph for the card.
  title text not null default '',
  summary text not null default '',
  -- The structured intake; see server/receptionist/intake.ts.
  intake jsonb not null default '{}'::jsonb,
  urgency text not null default 'normal' check (urgency in ('low', 'normal', 'high')),
  transcript text not null default '',

  -- After the call: recording → transcript → intake → proposals → notify.
  processing text not null default 'pending'
    check (processing in ('pending', 'processing', 'done', 'failed', 'skipped')),
  processing_attempts integer not null default 0,
  processing_error text,
  processing_lease_until timestamptz,

  -- The phone provider's identifiers. `call_sid` is the idempotency key for
  -- every webhook about one call.
  call_sid text,
  provider_call_id text,
  recording_sid text,
  recording_url text,
  recording_seconds integer,
  recording_channels integer,
  recording_deleted_at timestamptz,

  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,

  owner_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint inquiries_id_workspace_key unique (id, workspace_id),
  constraint inquiries_phone_number_fkey
    foreign key (phone_number_id, workspace_id)
    references public.phone_numbers (id, workspace_id) on delete set null (phone_number_id)
);

create unique index if not exists inquiries_call_sid_idx
  on public.inquiries (call_sid)
  where call_sid is not null;

create index if not exists inquiries_workspace_recent_idx
  on public.inquiries (workspace_id, started_at desc);

create index if not exists inquiries_caller_idx
  on public.inquiries (workspace_id, caller_phone, started_at desc);

create index if not exists inquiries_processing_idx
  on public.inquiries (processing, updated_at)
  where processing in ('pending', 'processing', 'failed');

drop trigger if exists set_inquiries_updated_at on public.inquiries;
create trigger set_inquiries_updated_at before update on public.inquiries
  for each row execute function public.set_updated_at();

alter table public.inquiries enable row level security;

drop policy if exists "members read inquiries" on public.inquiries;
create policy "members read inquiries" on public.inquiries
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- The approval queue
--
-- A proposal is frozen when it is made. The owner may edit it before
-- approving — the edit is validated against the same schema and stored as the
-- payload that runs — but once a row leaves `proposed` its payload never
-- changes again. Execution claims the row by moving it from `approved` to
-- `executing` in one conditional update, so a double tap runs it once.
--
-- `unknown` is terminal, like an email send that timed out: an SMS provider
-- that did not answer may still have delivered, and a blind retry is how one
-- approval becomes two messages.
-- ---------------------------------------------------------------------------

create table if not exists public.inquiry_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  inquiry_id uuid not null,

  kind text not null check (kind in ('booking', 'sms', 'reply', 'callback')),
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'executing', 'done',
                      'failed', 'unknown', 'dismissed')),
  payload jsonb not null,
  -- Why the AI proposed it, in a sentence the owner can read.
  rationale text not null default '',
  result jsonb,
  error text,

  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint inquiry_actions_inquiry_fkey
    foreign key (inquiry_id, workspace_id)
    references public.inquiries (id, workspace_id) on delete cascade
);

create index if not exists inquiry_actions_inquiry_idx
  on public.inquiry_actions (inquiry_id, created_at);

create index if not exists inquiry_actions_open_idx
  on public.inquiry_actions (workspace_id, status)
  where status in ('proposed', 'approved', 'executing');

drop trigger if exists set_inquiry_actions_updated_at on public.inquiry_actions;
create trigger set_inquiry_actions_updated_at before update on public.inquiry_actions
  for each row execute function public.set_updated_at();

alter table public.inquiry_actions enable row level security;

drop policy if exists "members read inquiry actions" on public.inquiry_actions;
create policy "members read inquiry actions" on public.inquiry_actions
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  inquiry_id uuid,
  action_id uuid references public.inquiry_actions (id) on delete set null,

  starts_at timestamptz not null,
  ends_at timestamptz not null,
  title text not null,
  customer_name text not null default '',
  customer_phone text,
  address text not null default '',
  notes text not null default '',
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),

  -- Set when the booking was also written to a connected calendar.
  calendar_provider text,
  calendar_event_id text,
  calendar_error text,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bookings_time_check check (ends_at > starts_at),
  constraint bookings_inquiry_fkey
    foreign key (inquiry_id, workspace_id)
    references public.inquiries (id, workspace_id) on delete set null (inquiry_id)
);

-- One booking per approved proposal, whatever retries happen. Not partial:
-- the booking code upserts on (action_id), and Postgres cannot infer a
-- partial index from a bare column list (42P10). NULLs stay distinct, so
-- bookings without a proposal never conflict.
create unique index if not exists bookings_action_idx
  on public.bookings (action_id);

create index if not exists bookings_workspace_time_idx
  on public.bookings (workspace_id, starts_at)
  where status = 'confirmed';

drop trigger if exists set_bookings_updated_at on public.bookings;
create trigger set_bookings_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();

alter table public.bookings enable row level security;

drop policy if exists "members read bookings" on public.bookings;
create policy "members read bookings" on public.bookings
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- SMS
-- ---------------------------------------------------------------------------

create table if not exists public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  inquiry_id uuid,
  action_id uuid references public.inquiry_actions (id) on delete set null,

  direction text not null check (direction in ('outbound', 'inbound')),
  -- 'customer' for the caller, 'owner' for the notification to the business.
  audience text not null default 'customer' check (audience in ('customer', 'owner')),
  to_phone text not null,
  from_phone text not null,
  body text not null,
  provider_sid text,
  status text not null default 'queued',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sms_messages_inquiry_fkey
    foreign key (inquiry_id, workspace_id)
    references public.inquiries (id, workspace_id) on delete set null (inquiry_id)
);

create unique index if not exists sms_messages_provider_sid_idx
  on public.sms_messages (provider_sid)
  where provider_sid is not null;

create index if not exists sms_messages_workspace_idx
  on public.sms_messages (workspace_id, created_at desc);

drop trigger if exists set_sms_messages_updated_at on public.sms_messages;
create trigger set_sms_messages_updated_at before update on public.sms_messages
  for each row execute function public.set_updated_at();

alter table public.sms_messages enable row level security;

drop policy if exists "members read sms" on public.sms_messages;
create policy "members read sms" on public.sms_messages
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Photo upload links
--
-- Only the sha-256 of the token is stored. The token itself exists in the SMS
-- and nowhere else, so a database read cannot be turned into an upload link.
-- ---------------------------------------------------------------------------

create table if not exists public.inquiry_upload_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  inquiry_id uuid not null,
  token_hash text not null,
  max_files integer not null default 10 check (max_files between 1 and 30),
  -- Signed upload URLs handed out so far. Capped, so a leaked link cannot
  -- mint unlimited uploads that are never confirmed.
  prepared_count integer not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),

  constraint inquiry_upload_links_token_key unique (token_hash),
  constraint inquiry_upload_links_inquiry_fkey
    foreign key (inquiry_id, workspace_id)
    references public.inquiries (id, workspace_id) on delete cascade
);

alter table public.inquiry_upload_links enable row level security;
-- No policy: server-only.

create table if not exists public.inquiry_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  inquiry_id uuid not null,
  link_id uuid references public.inquiry_upload_links (id) on delete set null,
  storage_path text not null,
  file_name text not null default '',
  mime_type text not null,
  size_bytes integer not null check (size_bytes > 0),
  created_at timestamptz not null default now(),

  constraint inquiry_files_inquiry_fkey
    foreign key (inquiry_id, workspace_id)
    references public.inquiries (id, workspace_id) on delete cascade
);

create index if not exists inquiry_files_inquiry_idx
  on public.inquiry_files (inquiry_id, created_at);

-- Confirming the same upload twice registers it once.
create unique index if not exists inquiry_files_path_idx
  on public.inquiry_files (storage_path);

alter table public.inquiry_files enable row level security;

drop policy if exists "members read inquiry files" on public.inquiry_files;
create policy "members read inquiry files" on public.inquiry_files
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- Uploads arrive through signed upload URLs straight from the customer's
-- browser, so the bucket itself enforces size and type. The confirm step
-- checks both again before a file is attached to an inquiry.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'inquiry-files', 'inquiry-files', false, 15728640,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
        'image/gif', 'application/pdf', 'video/mp4', 'video/quicktime']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Objects are named `<workspace_id>/<inquiry_id>/<file>`. Members read their
-- own workspace's files through signed URLs; uploads come from the server.
drop policy if exists "workspace inquiry file objects" on storage.objects;
create policy "workspace inquiry file objects" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'inquiry-files'
    and public.is_workspace_member(public.workspace_id_from_object_name(name))
  );

-- Hands out up to p_count signed-upload reservations for a link, never more
-- than twice its file limit in total. Returns how many were granted.
create or replace function public.reserve_upload_urls(p_link_id uuid, p_count int)
returns int
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  room int;
  granted int;
begin
  select l.max_files * 2 - l.prepared_count into room
    from public.inquiry_upload_links l
   where l.id = p_link_id and l.expires_at > now()
   for update;
  granted := greatest(0, least(coalesce(room, 0), p_count));
  if granted > 0 then
    update public.inquiry_upload_links
       set prepared_count = prepared_count + granted
     where id = p_link_id;
  end if;
  return granted;
end;
$$;

revoke all on function public.reserve_upload_urls(uuid, int) from public, anon, authenticated;
grant execute on function public.reserve_upload_urls(uuid, int) to service_role;

-- ---------------------------------------------------------------------------
-- Weekly reports
-- ---------------------------------------------------------------------------

create table if not exists public.weekly_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The Monday the week began, in the profile's timezone.
  week_start date not null,
  stats jsonb not null,
  sent_to text[],
  sent_at timestamptz,
  created_at timestamptz not null default now(),

  constraint weekly_reports_week_key unique (workspace_id, week_start)
);

alter table public.weekly_reports enable row level security;

drop policy if exists "members read weekly reports" on public.weekly_reports;
create policy "members read weekly reports" on public.weekly_reports
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Post-call processing claim.
--
-- Same discipline as the other claims: one worker per inquiry, and a row a
-- crashed worker stranded returns to the pool when its lease expires. Failed
-- rows are retried up to five attempts, then left for a person.
-- ---------------------------------------------------------------------------

create or replace function public.claim_inquiry_processing(
  p_id uuid,
  p_lease_ms int,
  p_limit int default 1
)
returns setof public.inquiries
language sql
volatile
security invoker
set search_path = public
as $$
  update public.inquiries i
     set processing = 'processing',
         processing_attempts = i.processing_attempts + 1,
         processing_lease_until = now() + make_interval(secs => p_lease_ms / 1000.0)
   where i.id in (
     select id from public.inquiries
      where (p_id is null or id = p_id)
        and (
          processing = 'pending'
          or (processing = 'failed' and processing_attempts < 5)
          or (processing = 'processing' and processing_lease_until < now())
        )
        -- Only once the provider has said where the recording is, or the
        -- channel never had one. A call that ended without a recording is
        -- given ten minutes for the recording webhook, which Twilio sends
        -- after the call-ended one, before it is processed as silent.
        and (
          recording_url is not null
          or channel = 'sms'
          or ended_at < now() - interval '10 minutes'
        )
      order by updated_at asc
      limit greatest(p_limit, 1)
      for update skip locked
   )
  returning i.*;
$$;

revoke all on function public.claim_inquiry_processing(uuid, int, int) from public, anon, authenticated;
grant execute on function public.claim_inquiry_processing(uuid, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- Google Calendar joins the connector family.
--
-- The calendar is the business's, not a mailbox, but the same rules hold:
-- Composio keeps the tokens, the account is bound to the user who connected
-- it, and the auth config is pinned to the two scopes we use.
-- ---------------------------------------------------------------------------

alter table public.connector_accounts drop constraint if exists connector_accounts_provider_check;
alter table public.connector_accounts
  add constraint connector_accounts_provider_check
  check (provider in ('gmail', 'outlook', 'googlecalendar'));

alter table public.connector_oauth_states drop constraint if exists connector_oauth_states_provider_check;
alter table public.connector_oauth_states
  add constraint connector_oauth_states_provider_check
  check (provider in ('gmail', 'outlook', 'googlecalendar'));

alter table public.connector_actions drop constraint if exists connector_actions_provider_check;
alter table public.connector_actions
  add constraint connector_actions_provider_check
  check (provider in ('gmail', 'outlook', 'googlecalendar'));

-- Read by the booking code for the pinned toolkit version. No assistant is
-- granted a calendar account, so discovery never offers these to a model:
-- bookings are made by the server, after the owner approves one.
insert into public.connector_actions (
  action_key, provider, tool_slug, tool_version, schema_hash, capability,
  risk, approval_policy, retry_policy, normalizer, result_version, renderer, enabled)
values
  ('calendar.busy', 'googlecalendar', 'GOOGLECALENDAR_FIND_FREE_SLOTS', 'unpinned', 'pending',
   'read', 'read', 'none', 'safe_retry', 'calendar.busy', 'calendar.busy.v1', 'calendar.busy.v1', true),
  ('calendar.create', 'googlecalendar', 'GOOGLECALENDAR_CREATE_EVENT', 'unpinned', 'pending',
   'send', 'side_effect', 'always', 'never', 'calendar.create', 'calendar.create.v1', 'calendar.create.v1', true)
on conflict (action_key, provider) do nothing;
