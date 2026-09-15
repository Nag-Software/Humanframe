-- Phase 4.1: email notification.
--
-- Same shape as the commitment wake: Supabase is the truth, a detached durable
-- workflow does the sending, and the claim is the only atomic piece. What is
-- new is that a notification must be *created in the same transaction as the
-- message it is about* — otherwise a retried hook can write one without the
-- other, and the user is either emailed about a message that is not there or
-- never told about one that is.

-- ---------------------------------------------------------------------------
-- Per-user notification settings. Email is opt-in: the default is off, and
-- nothing is sent until a person turns it on themselves.
-- ---------------------------------------------------------------------------

create table if not exists public.notification_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email_enabled boolean not null default false,
  reminders boolean not null default true,
  background_done boolean not null default true,
  approval_needed boolean not null default true,
  -- Local wall-clock times. Null means no quiet hours.
  quiet_hours_start time,
  quiet_hours_end time,
  -- The zone the quiet hours are read in. Falls back to the membership's zone.
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

drop trigger if exists set_notification_settings_updated_at on public.notification_settings;
create trigger set_notification_settings_updated_at
  before update on public.notification_settings
  for each row execute function public.set_updated_at();

alter table public.notification_settings enable row level security;

-- A person manages their own settings, and only inside a workspace they belong
-- to. Nobody edits anyone else's.
drop policy if exists "own notification settings" on public.notification_settings;
create policy "own notification settings" on public.notification_settings
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- The outbox.
--
-- `recipient_user_id` names *who* to tell, never an address: the address is
-- resolved server-side from the verified user record at send time, so a model
-- argument can never redirect an email.
-- ---------------------------------------------------------------------------

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid not null,
  recipient_user_id uuid not null references auth.users (id) on delete cascade,
  thread_id uuid not null,
  -- The message this is about. `messages` is keyed (id, created_at) for
  -- partitioning, so this cannot be a foreign key; it is the projection's id.
  source_message_id uuid,
  event_type text not null
    check (event_type in ('reminder', 'background_done', 'approval_needed')),
  subject_type text
    check (subject_type in ('commitment', 'task', 'approval')),
  subject_id uuid,
  dedupe_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  available_at timestamptz not null default now(),
  attempt_count int not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  last_error jsonb,
  provider_message_id text,
  skipped_reason text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, dedupe_key),
  constraint notification_outbox_assistant_fk
    foreign key (assistant_id, workspace_id)
    references public.assistants (id, workspace_id) on delete cascade,
  constraint notification_outbox_thread_fk
    foreign key (thread_id, workspace_id)
    references public.threads (id, workspace_id) on delete cascade
);

create index if not exists notification_outbox_ready_idx
  on public.notification_outbox (available_at)
  where status in ('pending', 'sending');
create index if not exists notification_outbox_recipient_idx
  on public.notification_outbox (workspace_id, recipient_user_id, created_at desc);

drop trigger if exists set_notification_outbox_updated_at on public.notification_outbox;
create trigger set_notification_outbox_updated_at
  before update on public.notification_outbox
  for each row execute function public.set_updated_at();

alter table public.notification_outbox enable row level security;

-- Read-only for the browser, and only your own notifications. There is
-- deliberately no insert, update or delete policy: a signed-in client cannot
-- create a sendable job, cannot retry one, and cannot mark one delivered.
-- Every write happens through the service role, from the runtime.
drop policy if exists "read own notifications" on public.notification_outbox;
create policy "read own notifications" on public.notification_outbox
  for select to authenticated
  using (
    recipient_user_id = (select auth.uid())
    and public.is_workspace_member(workspace_id)
  );

-- ---------------------------------------------------------------------------
-- Message and notification, written together.
--
-- Hooks are at-least-once, so both writes are upserts on their own stable key:
-- the same event replayed produces one message and one notification, and a
-- crash between them is impossible because there is no "between".
-- ---------------------------------------------------------------------------

create or replace function public.record_assistant_message(
  p_workspace_id uuid,
  p_assistant_id uuid,
  p_thread_id uuid,
  p_role text,
  p_channel text,
  p_content jsonb,
  p_source_message_id text,
  p_created_at timestamptz,
  p_eve_session_id text,
  p_eve_turn_id text,
  p_notify_user_id uuid default null,
  p_event_type text default null,
  p_dedupe_key text default null,
  p_subject_type text default null,
  p_subject_id uuid default null
)
returns table (message_id uuid, notification_id uuid)
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_message_id uuid;
  v_notification_id uuid;
begin
  insert into public.messages as m (
    workspace_id, assistant_id, thread_id, channel, role, content,
    source_message_id, created_at, eve_session_id, eve_turn_id)
  values (
    p_workspace_id, p_assistant_id, p_thread_id, p_channel, p_role, p_content,
    p_source_message_id, p_created_at, p_eve_session_id, p_eve_turn_id)
  on conflict (thread_id, source_message_id, created_at) do nothing
  returning m.id into v_message_id;

  if v_message_id is null then
    select id into v_message_id
      from public.messages
     where thread_id = p_thread_id
       and source_message_id = p_source_message_id
       and created_at = p_created_at;
  end if;

  -- A notification is optional: most messages produce none. A hidden wake
  -- marker never reaches this branch, because the caller does not ask for one.
  if p_notify_user_id is not null and p_event_type is not null
     and p_dedupe_key is not null then
    insert into public.notification_outbox as n (
      workspace_id, assistant_id, recipient_user_id, thread_id,
      source_message_id, event_type, subject_type, subject_id, dedupe_key)
    values (
      p_workspace_id, p_assistant_id, p_notify_user_id, p_thread_id,
      v_message_id, p_event_type, p_subject_type, p_subject_id, p_dedupe_key)
    on conflict (workspace_id, dedupe_key) do nothing
    returning n.id into v_notification_id;

    if v_notification_id is null then
      select id into v_notification_id
        from public.notification_outbox
       where workspace_id = p_workspace_id and dedupe_key = p_dedupe_key;
    end if;
  end if;

  return query select v_message_id, v_notification_id;
end;
$$;

revoke all on function public.record_assistant_message(
  uuid, uuid, uuid, text, text, jsonb, text, timestamptz, text, text,
  uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_assistant_message(
  uuid, uuid, uuid, text, text, jsonb, text, timestamptz, text, text,
  uuid, text, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The claim. Identical discipline to claim_commitments_for_wake: due rows, and
-- rows stranded in `sending` by a worker that died mid-flight.
-- ---------------------------------------------------------------------------

create or replace function public.claim_notifications(
  p_limit int,
  p_lease_ms int,
  p_id uuid default null
)
returns setof public.notification_outbox
language sql
volatile
security invoker
set search_path = public
as $$
  update public.notification_outbox n
     set status = 'sending',
         lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         attempt_count = n.attempt_count + 1,
         updated_at = now()
   where n.id in (
     select id from public.notification_outbox
      where status in ('pending', 'sending')
        and available_at <= now()
        and (lease_until is null or lease_until < now())
        and (p_id is null or id = p_id)
      order by available_at
      limit greatest(p_limit, 0)
      for update skip locked
   )
  returning n.*;
$$;

revoke all on function public.claim_notifications(int, int, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_notifications(int, int, uuid) to service_role;
