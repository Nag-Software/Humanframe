-- ---------------------------------------------------------------------------
-- The approved action register.
--
-- This is the authorization fact for connectors. Composio's catalogue says what
-- *exists*; this says what Humanframe will run, under which capability, at
-- which risk, normalised into which versioned result contract, rendered by
-- which component we actually ship.
--
-- Rows are configuration, not code. They point at adapters and renderers that
-- are already deployed in the repo; nothing here is downloaded or evaluated.
-- An action whose adapter or renderer is unknown to the running build is not
-- executable, whatever the row says.
-- ---------------------------------------------------------------------------

create table if not exists public.connector_actions (
  id uuid primary key default gen_random_uuid(),

  -- Humanframe's stable name. The model and the approval record speak this,
  -- never a provider slug, so a provider rename cannot silently repoint an
  -- approved action at something else.
  action_key text not null check (action_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  provider text not null check (provider in ('gmail', 'outlook')),

  -- Exactly which provider tool, at exactly which version.
  tool_slug text not null,
  tool_version text not null default 'unpinned',
  -- sha-256 of the provider's input schema as we validated it. Drift blocks.
  schema_hash text not null,

  -- What a grant must carry for this action to be discoverable at all.
  capability text not null check (capability in ('read', 'send')),

  -- 'read' never leaves a trace the user cannot undo. 'side_effect' does, and
  -- is therefore never executed from a model argument — only from a stored,
  -- approved action record.
  risk text not null check (risk in ('read', 'side_effect')),
  approval_policy text not null default 'always'
    check (approval_policy in ('none', 'always')),

  -- Retry stance. 'never' is for effects a provider cannot make idempotent;
  -- an ambiguous result there is terminal and a person resolves it.
  retry_policy text not null default 'never'
    check (retry_policy in ('never', 'safe_retry')),

  -- Names of adapters and renderers compiled into the build. Resolved through
  -- an in-repo registry; an unknown name fails closed.
  normalizer text not null,
  result_version text not null,
  renderer text not null,

  enabled boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint connector_actions_key unique (action_key, provider)
);

create index if not exists connector_actions_enabled_idx
  on public.connector_actions (provider, capability)
  where enabled;

drop trigger if exists set_connector_actions_updated_at on public.connector_actions;
create trigger set_connector_actions_updated_at
  before update on public.connector_actions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The action record: one stored, immutable side effect awaiting a decision.
--
-- The model proposes; this is what it proposed, frozen. The approval card
-- renders THIS row, and after approval the server re-executes THIS row — never
-- a fresh set of model arguments. Changing the account, the payload or the
-- schema produces a new record, and therefore a new approval.
-- ---------------------------------------------------------------------------

create table if not exists public.connector_action_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_id uuid not null,
  assistant_id uuid not null,
  thread_id uuid,

  action_key text not null,
  provider text not null,
  -- Snapshotted from the register at creation, so a later register edit cannot
  -- retroactively change what was approved.
  tool_slug text not null,
  tool_version text not null,
  schema_hash text not null,
  action_version text not null,

  -- The exact arguments the server will send, and their hash.
  payload jsonb not null,
  payload_hash text not null,

  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'rejected',
                      'executing', 'succeeded', 'unknown', 'failed', 'expired')),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  expires_at timestamptz not null,

  -- The eve call the approval was attached to, for audit.
  approval_call_id text,
  result jsonb,
  last_error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint connector_action_records_id_workspace_key unique (id, workspace_id),
  constraint connector_action_records_account_fkey
    foreign key (account_id, workspace_id)
    references public.connector_accounts (id, workspace_id) on delete cascade,
  constraint connector_action_records_assistant_fkey
    foreign key (assistant_id, workspace_id)
    references public.assistants (id, workspace_id) on delete cascade
);

create index if not exists connector_action_records_open_idx
  on public.connector_action_records (workspace_id, status)
  where status in ('pending_approval', 'approved', 'executing');

drop trigger if exists set_connector_action_records_updated_at
  on public.connector_action_records;
create trigger set_connector_action_records_updated_at
  before update on public.connector_action_records
  for each row execute function public.set_updated_at();

alter table public.connector_actions enable row level security;
alter table public.connector_action_records enable row level security;

-- The register is readable by signed-in users so the settings page can show
-- what an account actually supports. It is never writable from a browser.
drop policy if exists "read action register" on public.connector_actions;
create policy "read action register" on public.connector_actions
  for select to authenticated using (true);

drop policy if exists "read own action records" on public.connector_action_records;
create policy "read own action records" on public.connector_action_records
  for select to authenticated
  using (
    exists (
      select 1 from public.connector_accounts a
       where a.id = connector_action_records.account_id
         and a.workspace_id = connector_action_records.workspace_id
         and a.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Seed the four email actions, disabled.
--
-- Enabling one is a row update, not a deploy. Adding a genuinely new *kind* of
-- action still needs adapter and renderer code, which is the point: the
-- register can turn shipped capabilities on and off, not invent them.
-- ---------------------------------------------------------------------------

insert into public.connector_actions (
  action_key, provider, tool_slug, tool_version, schema_hash, capability,
  risk, approval_policy, retry_policy, normalizer, result_version, renderer, enabled)
values
  ('email.search', 'gmail', 'GMAIL_FETCH_EMAILS', 'unpinned', 'pending',
   'read', 'read', 'none', 'safe_retry', 'email.list', 'email.list.v1', 'email.list.v1', false),
  ('email.read', 'gmail', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'unpinned', 'pending',
   'read', 'read', 'none', 'safe_retry', 'email.thread', 'email.thread.v1', 'email.thread.v1', false),
  ('email.send', 'gmail', 'GMAIL_SEND_EMAIL', 'unpinned', 'pending',
   'send', 'side_effect', 'always', 'never', 'email.send', 'email.send.v1', 'email.send-approval.v1', false),
  ('email.search', 'outlook', 'OUTLOOK_SEARCH_MESSAGES', 'unpinned', 'pending',
   'read', 'read', 'none', 'safe_retry', 'email.list', 'email.list.v1', 'email.list.v1', false),
  ('email.read', 'outlook', 'OUTLOOK_GET_MESSAGE', 'unpinned', 'pending',
   'read', 'read', 'none', 'safe_retry', 'email.thread', 'email.thread.v1', 'email.thread.v1', false),
  ('email.send', 'outlook', 'OUTLOOK_SEND_EMAIL', 'unpinned', 'pending',
   'send', 'side_effect', 'always', 'never', 'email.send', 'email.send.v1', 'email.send-approval.v1', false)
on conflict (action_key, provider) do nothing;
