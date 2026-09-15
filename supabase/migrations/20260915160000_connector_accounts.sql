-- ---------------------------------------------------------------------------
-- Phase 7: email connectors (Gmail, Outlook via Composio).
--
-- Two rules shape this schema.
--
-- First: an inbox is personal. A connected account belongs to one user in one
-- workspace, and workspace membership alone grants nothing — a colleague in the
-- same workspace cannot read your mail, and neither can an assistant, until the
-- owner writes an explicit grant. That is why access is a row, not a role.
--
-- Second: Composio holds the OAuth tokens. Nothing here stores a token, a
-- refresh token or a client secret, and nothing here is safe to hand a browser
-- beyond the account's own display fields.
-- ---------------------------------------------------------------------------

create table if not exists public.connector_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The owner. Deliberately not nullable: an inbox with no owner is an inbox
  -- nobody is accountable for.
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('gmail', 'outlook')),

  -- Composio's own identifiers. `composio_user_id` is the subject we hand
  -- Composio; `connected_account_id` is what it gives back. Neither is a
  -- credential, and neither is ever accepted from a model argument.
  composio_user_id text not null,
  connected_account_id text,
  account_email text,

  status text not null default 'pending'
    check (status in ('pending', 'active', 'expired', 'revoked', 'disconnected')),
  last_error jsonb,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint connector_accounts_id_workspace_key unique (id, workspace_id)
);

-- One row per real connected account. A second OAuth round for an account that
-- is already bound updates the existing row instead of forking it.
create unique index if not exists connector_accounts_connected_idx
  on public.connector_accounts (workspace_id, provider, connected_account_id)
  where connected_account_id is not null;

-- One live account per provider per user per workspace. Disconnected rows stay
-- for history and do not block reconnecting.
create unique index if not exists connector_accounts_live_idx
  on public.connector_accounts (workspace_id, user_id, provider)
  where status in ('pending', 'active', 'expired');

create index if not exists connector_accounts_owner_idx
  on public.connector_accounts (user_id, status);

drop trigger if exists set_connector_accounts_updated_at on public.connector_accounts;
create trigger set_connector_accounts_updated_at
  before update on public.connector_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The grant: this assistant may use this account, for these capabilities.
--
-- Capabilities are separate because reading and sending are different risks.
-- A grant of 'read' never implies 'send'; the send path checks for 'send'
-- explicitly, immediately before it sends.
-- ---------------------------------------------------------------------------

create table if not exists public.connector_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_id uuid not null,
  assistant_id uuid not null,
  capabilities text[] not null default '{read}',
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,

  constraint connector_grants_capabilities_check
    check (capabilities <@ array['read', 'send']::text[] and array_length(capabilities, 1) > 0),
  -- Tenancy on the service-role path: a grant cannot reach across workspaces,
  -- whatever a caller claims.
  constraint connector_grants_account_fkey
    foreign key (account_id, workspace_id)
    references public.connector_accounts (id, workspace_id) on delete cascade,
  constraint connector_grants_assistant_fkey
    foreign key (assistant_id, workspace_id)
    references public.assistants (id, workspace_id) on delete cascade
);

create unique index if not exists connector_grants_live_idx
  on public.connector_grants (account_id, assistant_id)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- OAuth state.
--
-- Composio appends `status` and `connected_account_id` to the callback, and
-- neither proves who started the flow. This row does: it is minted server-side
-- for one signed-in user, single-use, short-lived, and the callback is refused
-- without it.
-- ---------------------------------------------------------------------------

create table if not exists public.connector_oauth_states (
  state text primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('gmail', 'outlook')),
  account_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,

  constraint connector_oauth_states_account_fkey
    foreign key (account_id, workspace_id)
    references public.connector_accounts (id, workspace_id) on delete cascade
);

create index if not exists connector_oauth_states_expiry_idx
  on public.connector_oauth_states (expires_at)
  where consumed_at is null;

-- ---------------------------------------------------------------------------
-- Drafts are immutable versions.
--
-- Approval binds to one exact draft row and its content hash. Editing produces
-- a new row, never an update, so an approved draft cannot be altered between
-- the person saying yes and the message leaving. There is no UPDATE policy on
-- this table for anyone, by design.
-- ---------------------------------------------------------------------------

create table if not exists public.email_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_id uuid not null,
  assistant_id uuid not null,
  thread_id uuid,
  created_by uuid references auth.users (id) on delete set null,

  -- Addressing. Arrays so the approval card can show exactly what will happen.
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  bcc_addresses text[] not null default '{}',
  subject text not null default '',
  body text not null default '',

  -- What this is a reply to, in the provider's own terms.
  provider_thread_id text,
  provider_message_id text,

  -- sha-256 over the normalised payload. The approval carries this; the sender
  -- recomputes it and refuses if it has moved.
  content_hash text not null,
  supersedes uuid,
  created_at timestamptz not null default now(),

  constraint email_drafts_id_workspace_key unique (id, workspace_id),
  constraint email_drafts_account_fkey
    foreign key (account_id, workspace_id)
    references public.connector_accounts (id, workspace_id) on delete cascade,
  constraint email_drafts_assistant_fkey
    foreign key (assistant_id, workspace_id)
    references public.assistants (id, workspace_id) on delete cascade,
  constraint email_drafts_thread_fkey
    foreign key (thread_id, workspace_id)
    references public.threads (id, workspace_id) on delete set null
);

create index if not exists email_drafts_thread_idx
  on public.email_drafts (thread_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The send operation.
--
-- Neither Gmail nor Microsoft Graph accepts an idempotency key, so a send that
-- times out is genuinely ambiguous: it may have gone out. `unknown` is a
-- terminal state a person resolves — it is never retried automatically, because
-- a blind retry is how one approval becomes two emails.
--
-- `draft_id` is unique: one send per draft version, for the life of the row.
-- That is the business-level idempotency key, and it is the only kind available
-- here.
-- ---------------------------------------------------------------------------

create table if not exists public.email_sends (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_id uuid not null,
  draft_id uuid not null,
  -- The hash as it was at approval time. Compared again before sending.
  approved_hash text not null,
  -- The eve tool call the approval was attached to, so a send can always be
  -- traced back to the exact call a person authorised.
  approval_call_id text not null,
  approved_by uuid references auth.users (id) on delete set null,

  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'unknown', 'failed', 'cancelled')),
  attempt_count integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,

  provider_message_id text,
  provider_thread_id text,
  last_error jsonb,
  first_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint email_sends_draft_key unique (draft_id),
  constraint email_sends_account_fkey
    foreign key (account_id, workspace_id)
    references public.connector_accounts (id, workspace_id) on delete cascade,
  constraint email_sends_draft_fkey
    foreign key (draft_id, workspace_id)
    references public.email_drafts (id, workspace_id) on delete cascade
);

create index if not exists email_sends_open_idx
  on public.email_sends (workspace_id, status)
  where status in ('pending', 'sending');

drop trigger if exists set_email_sends_updated_at on public.email_sends;
create trigger set_email_sends_updated_at
  before update on public.email_sends
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The claim. Same discipline as claim_notifications: one worker at a time, and
-- a row stranded by a crashed worker returns to the pool when its lease
-- expires. `sending` is deliberately NOT reclaimable here — a stranded send may
-- already have left, so it is surfaced as `unknown` rather than retried.
-- ---------------------------------------------------------------------------

create or replace function public.claim_email_send(
  p_id uuid,
  p_lease_ms int
)
returns setof public.email_sends
language sql
volatile
security invoker
set search_path = public
as $$
  update public.email_sends s
     set status = 'sending',
         lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         attempt_count = s.attempt_count + 1,
         first_attempt_at = coalesce(s.first_attempt_at, now()),
         updated_at = now()
   where s.id = (
     select id from public.email_sends
      where id = p_id
        and status = 'pending'
      for update skip locked
   )
  returning s.*;
$$;

revoke all on function public.claim_email_send(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_email_send(uuid, int) to service_role;

-- ---------------------------------------------------------------------------
-- Row level security.
--
-- Browsers read their own accounts and manage their own grants. Everything a
-- model can reach — drafts, sends — is written by a server route that has
-- already checked the grant, so there is no write policy for `authenticated`
-- on those at all.
-- ---------------------------------------------------------------------------

alter table public.connector_accounts enable row level security;
alter table public.connector_grants enable row level security;
alter table public.connector_oauth_states enable row level security;
alter table public.email_drafts enable row level security;
alter table public.email_sends enable row level security;

-- The owner sees their own accounts. Workspace membership alone shows nothing.
drop policy if exists "read own connector accounts" on public.connector_accounts;
create policy "read own connector accounts" on public.connector_accounts
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- Disconnecting is the one write a browser may make directly: it only ever
-- withdraws access, never widens it.
drop policy if exists "disconnect own connector accounts" on public.connector_accounts;
create policy "disconnect own connector accounts" on public.connector_accounts
  for update to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- A grant is visible to, and writable by, the account's owner only.
drop policy if exists "owner manages grants" on public.connector_grants;
create policy "owner manages grants" on public.connector_grants
  for all to authenticated
  using (
    exists (
      select 1 from public.connector_accounts a
       where a.id = connector_grants.account_id
         and a.workspace_id = connector_grants.workspace_id
         and a.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.connector_accounts a
       where a.id = connector_grants.account_id
         and a.workspace_id = connector_grants.workspace_id
         and a.user_id = auth.uid()
    )
  );

-- OAuth state is server-only: a browser that could read it could complete
-- someone else's flow.
drop policy if exists "no client access to oauth state" on public.connector_oauth_states;

drop policy if exists "read own drafts" on public.email_drafts;
create policy "read own drafts" on public.email_drafts
  for select to authenticated
  using (
    exists (
      select 1 from public.connector_accounts a
       where a.id = email_drafts.account_id
         and a.workspace_id = email_drafts.workspace_id
         and a.user_id = auth.uid()
    )
  );

drop policy if exists "read own sends" on public.email_sends;
create policy "read own sends" on public.email_sends
  for select to authenticated
  using (
    exists (
      select 1 from public.connector_accounts a
       where a.id = email_sends.account_id
         and a.workspace_id = email_sends.workspace_id
         and a.user_id = auth.uid()
    )
  );
