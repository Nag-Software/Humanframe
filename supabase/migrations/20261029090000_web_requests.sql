-- ---------------------------------------------------------------------------
-- Web first (docs/PIVOT.md, 29 Oct 2026): from inquiry to job.
--
--   widget         a chat on the business's own website that takes a complete
--                  job request — what, where, photos, contact, when — and
--                  hands it to the same inquiry pipeline as a call
--   quotes         a quote drafted from the owner's own price list, approved
--                  in the queue, and accepted by the customer
--   portals        one page per inquiry for the customer: status, quote,
--                  accept, pick a time, add photos
--   customer email every email to a customer, logged like the SMS
-- ---------------------------------------------------------------------------

-- Inquiries can come from the website, and a widget conversation is a draft
-- until the customer sends it.
alter table public.inquiries drop constraint if exists inquiries_channel_check;
alter table public.inquiries
  add constraint inquiries_channel_check check (channel in ('phone', 'voicemail', 'sms', 'web'));

alter table public.inquiries drop constraint if exists inquiries_status_check;
alter table public.inquiries
  add constraint inquiries_status_check check (status in ('draft', 'open', 'handled', 'dismissed'));

-- The processing claim ignores drafts: nothing is processed before it is sent.
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
        and status <> 'draft'
        and (
          processing = 'pending'
          or (processing = 'failed' and processing_attempts < 5)
          or (processing = 'processing' and processing_lease_until < now())
        )
        and (
          recording_url is not null
          or channel in ('sms', 'web')
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
-- Profile: the widget, and prices a quote can be computed from
-- ---------------------------------------------------------------------------

alter table public.business_profiles
  -- Public: it sits in the embed snippet on the business's site. It names a
  -- workspace's widget; it authorises nothing beyond starting a conversation.
  add column if not exists widget_key text not null
    default substr(replace(gen_random_uuid()::text, '-', ''), 1, 20),
  add column if not exists widget_enabled boolean not null default true,
  add column if not exists widget_greeting text not null default '',
  -- Hex colour for the launcher; null uses the brand's.
  add column if not exists widget_color text check (widget_color is null or widget_color ~ '^#[0-9a-fA-F]{6}$'),
  -- [{ "name": "Timepris", "unit": "time", "price": 950 }] — the only prices
  -- a drafted quote may use.
  add column if not exists price_items jsonb not null default '[]'::jsonb,
  add column if not exists prices_include_vat boolean not null default true,
  add column if not exists quote_valid_days integer not null default 30
    check (quote_valid_days between 1 and 365),
  add column if not exists quote_terms text not null default '';

create unique index if not exists business_profiles_widget_key_idx
  on public.business_profiles (widget_key);

-- ---------------------------------------------------------------------------
-- Widget conversations
-- ---------------------------------------------------------------------------

create table if not exists public.widget_sessions (
  -- The id is the conversation's credential in the visitor's browser.
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  inquiry_id uuid not null,
  messages jsonb not null default '[]'::jsonb,
  turns integer not null default 0,
  status text not null default 'active' check (status in ('active', 'submitted', 'abandoned')),
  -- What the conversation has collected so far, for the summary card.
  collected jsonb not null default '{}'::jsonb,
  origin text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,

  constraint widget_sessions_inquiry_fkey
    foreign key (inquiry_id, workspace_id)
    references public.inquiries (id, workspace_id) on delete cascade
);

create index if not exists widget_sessions_workspace_idx
  on public.widget_sessions (workspace_id, created_at desc);

drop trigger if exists set_widget_sessions_updated_at on public.widget_sessions;
create trigger set_widget_sessions_updated_at before update on public.widget_sessions
  for each row execute function public.set_updated_at();

alter table public.widget_sessions enable row level security;
-- No policy: server-only. The owner reads the conversation as the inquiry's
-- transcript.

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------

alter table public.inquiry_actions drop constraint if exists inquiry_actions_kind_check;
alter table public.inquiry_actions
  add constraint inquiry_actions_kind_check
  check (kind in ('booking', 'sms', 'reply', 'callback', 'quote'));

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  inquiry_id uuid not null,
  action_id uuid references public.inquiry_actions (id) on delete set null,
  -- Per-workspace running number, shown as "Tilbud 12".
  number integer not null,

  status text not null default 'sent'
    check (status in ('sent', 'accepted', 'declined', 'expired', 'withdrawn')),
  title text not null,
  -- [{ "description": "...", "quantity": 2, "unit": "time", "unitPrice": 950 }]
  lines jsonb not null,
  notes text not null default '',
  terms text not null default '',
  prices_include_vat boolean not null default true,
  subtotal numeric(12, 2) not null,
  vat numeric(12, 2) not null,
  total numeric(12, 2) not null,
  valid_until date not null,

  customer_name text not null default '',
  customer_email text,
  customer_phone text,

  sent_at timestamptz not null default now(),
  viewed_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint quotes_number_key unique (workspace_id, number),
  constraint quotes_inquiry_fkey
    foreign key (inquiry_id, workspace_id)
    references public.inquiries (id, workspace_id) on delete cascade
);

-- One quote per approved proposal, whatever retries happen.
create unique index if not exists quotes_action_idx on public.quotes (action_id);
create index if not exists quotes_workspace_idx on public.quotes (workspace_id, sent_at desc);

drop trigger if exists set_quotes_updated_at on public.quotes;
create trigger set_quotes_updated_at before update on public.quotes
  for each row execute function public.set_updated_at();

alter table public.quotes enable row level security;

drop policy if exists "members read quotes" on public.quotes;
create policy "members read quotes" on public.quotes
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- The next quote number for a workspace, taken under a row lock on the
-- workspace so two approvals at once never share a number.
create or replace function public.next_quote_number(p_workspace uuid)
returns integer
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  next_number integer;
begin
  perform 1 from public.workspaces where id = p_workspace for update;
  select coalesce(max(number), 0) + 1 into next_number
    from public.quotes where workspace_id = p_workspace;
  return next_number;
end;
$$;

revoke all on function public.next_quote_number(uuid) from public, anon, authenticated;
grant execute on function public.next_quote_number(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Customer portal: one page per inquiry
--
-- The token is the customer's only credential and travels in every message
-- we send them. It is kept readable, unlike the upload token, because the
-- owner must be able to share the link again; members can read it, and so
-- could reach the page anyway.
-- ---------------------------------------------------------------------------

create table if not exists public.inquiry_portals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  inquiry_id uuid not null,
  token text not null,
  created_at timestamptz not null default now(),
  last_viewed_at timestamptz,

  constraint inquiry_portals_token_key unique (token),
  constraint inquiry_portals_inquiry_key unique (inquiry_id),
  constraint inquiry_portals_inquiry_fkey
    foreign key (inquiry_id, workspace_id)
    references public.inquiries (id, workspace_id) on delete cascade
);

alter table public.inquiry_portals enable row level security;

drop policy if exists "members read portals" on public.inquiry_portals;
create policy "members read portals" on public.inquiry_portals
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Email to customers
-- ---------------------------------------------------------------------------

create table if not exists public.customer_emails (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  inquiry_id uuid,
  action_id uuid references public.inquiry_actions (id) on delete set null,
  to_email text not null,
  subject text not null,
  body text not null,
  status text not null default 'sending',
  provider_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_emails_inquiry_fkey
    foreign key (inquiry_id, workspace_id)
    references public.inquiries (id, workspace_id) on delete set null (inquiry_id)
);

create index if not exists customer_emails_workspace_idx
  on public.customer_emails (workspace_id, created_at desc);

drop trigger if exists set_customer_emails_updated_at on public.customer_emails;
create trigger set_customer_emails_updated_at before update on public.customer_emails
  for each row execute function public.set_updated_at();

alter table public.customer_emails enable row level security;

drop policy if exists "members read customer emails" on public.customer_emails;
create policy "members read customer emails" on public.customer_emails
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
