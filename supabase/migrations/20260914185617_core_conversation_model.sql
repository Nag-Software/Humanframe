-- Core conversation model.
--
-- One shared messages table for every assistant, user and channel. The chat
-- tables from 0001 are empty, so they are renamed and evolved rather than
-- duplicated. Two choices are deliberate and load-bearing:
--
--   1. messages' primary key is (id, created_at). Postgres requires the
--      partition key in every unique constraint, so this keeps
--      `partition by range (created_at)` a pure data migration later.
--   2. created_at is written from eve's event timestamp (meta.at), never from
--      now(). eve mints that value once and repeats it on replay, so a retried
--      hook hits the same unique key and becomes a no-op instead of a
--      duplicate row. Defaulting to now() would break that.
--
-- Raw messages never get embeddings. Only consolidated long-term memories do,
-- and those arrive in a later migration.

-- ---------------------------------------------------------------- threads

alter table public.maya_conversations rename to threads;
alter table public.threads rename constraint maya_conversations_pkey to threads_pkey;

alter table public.threads
  add column if not exists channel text not null default 'chat'
    check (channel in ('chat', 'live', 'facetime', 'system')),
  add column if not exists status text not null default 'active'
    check (status in ('active', 'archived')),
  add column if not exists eve_session_id text,
  add column if not exists last_message_at timestamptz not null default now();

alter table public.threads alter column assistant_id set not null;

drop index if exists public.maya_conversations_workspace_idx;

create unique index if not exists threads_eve_session_idx
  on public.threads (eve_session_id)
  where eve_session_id is not null;
create index if not exists threads_workspace_recent_idx
  on public.threads (workspace_id, last_message_at desc, id desc);
create index if not exists threads_assistant_recent_idx
  on public.threads (assistant_id, last_message_at desc, id desc);

alter table public.threads rename constraint maya_conversations_workspace_id_fkey
  to threads_workspace_id_fkey;
alter table public.threads rename constraint maya_conversations_assistant_id_fkey
  to threads_assistant_id_fkey;
alter table public.threads rename constraint maya_conversations_created_by_fkey
  to threads_created_by_fkey;

drop trigger if exists set_maya_conversations_updated_at on public.threads;
create trigger set_threads_updated_at
  before update on public.threads
  for each row execute function public.set_updated_at();

-- --------------------------------------------------------------- messages

-- The attachment link is dropped before the id type changes. It is not
-- recreated: a foreign key into a partitioned table must carry the partition
-- key, so the reference runs the other way — a message's content refers to the
-- attachment.
alter table public.maya_attachments drop constraint maya_attachments_message_id_fkey;

alter table public.maya_messages rename to messages;
alter table public.messages rename column conversation_id to thread_id;
alter table public.messages rename column parts to content;

alter table public.messages drop constraint maya_messages_pkey;
alter table public.messages
  alter column id drop default,
  alter column id type uuid using gen_random_uuid(),
  alter column id set default gen_random_uuid();
alter table public.messages add constraint messages_pkey primary key (id, created_at);

alter table public.messages
  add column assistant_id uuid not null
    references public.assistants (id) on delete cascade,
  add column channel text not null default 'chat'
    check (channel in ('chat', 'live', 'facetime', 'system')),
  add column source_message_id text,
  add column eve_session_id text,
  add column eve_turn_id text,
  drop column position;

alter table public.messages drop constraint maya_messages_role_check;
alter table public.messages
  add constraint messages_role_check
    check (role in ('system', 'user', 'assistant', 'tool')),
  add constraint messages_content_is_array
    check (jsonb_typeof(content) = 'array'),
  -- Files belong in Storage; content carries references, not bytes.
  add constraint messages_content_size
    check (pg_column_size(content) < 1000000);

alter table public.messages rename constraint maya_messages_conversation_id_fkey
  to messages_thread_id_fkey;
alter table public.messages rename constraint maya_messages_workspace_id_fkey
  to messages_workspace_id_fkey;

drop index if exists public.maya_messages_conversation_idx;
drop index if exists public.maya_messages_workspace_idx;

-- Cursor pagination reads this index; there is no OFFSET anywhere.
create index if not exists messages_thread_cursor_idx
  on public.messages (thread_id, created_at desc, id desc);
create index if not exists messages_workspace_recent_idx
  on public.messages (workspace_id, created_at desc);
create index if not exists messages_assistant_recent_idx
  on public.messages (assistant_id, created_at desc);

-- Idempotency for eve hooks: same event, same row. The index is deliberately
-- not partial — a partial index cannot be inferred as an ON CONFLICT target
-- through PostgREST. NULLs are distinct in Postgres, so rows without a source
-- id never conflict with each other.
create unique index if not exists messages_source_idx
  on public.messages (thread_id, source_message_id, created_at);

-- ------------------------------------------------------------ attachments

alter table public.maya_attachments rename to attachments;
alter table public.attachments rename constraint maya_attachments_pkey to attachments_pkey;
alter table public.attachments rename column conversation_id to thread_id;

alter table public.attachments
  alter column message_id type uuid using null,
  add column if not exists checksum text,
  drop column if exists url;

alter table public.attachments rename constraint maya_attachments_conversation_id_fkey
  to attachments_thread_id_fkey;
alter table public.attachments rename constraint maya_attachments_workspace_id_fkey
  to attachments_workspace_id_fkey;

drop index if exists public.maya_attachments_conversation_idx;
drop index if exists public.maya_attachments_workspace_idx;
create index if not exists attachments_thread_idx
  on public.attachments (thread_id, created_at desc);
create index if not exists attachments_workspace_idx
  on public.attachments (workspace_id, created_at desc);

-- ------------------------------------------------- agent run projection

-- Humanframe's readable view of an eve run. eve and Workflows own execution
-- state; this table holds status and identifiers only.
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid not null references public.assistants (id) on delete cascade,
  thread_id uuid references public.threads (id) on delete set null,
  eve_session_id text not null,
  eve_turn_id text not null,
  workflow_run_id text,
  status text not null check (status in
    ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  error jsonb,
  input_tokens bigint,
  output_tokens bigint,
  cost_usd numeric(12, 6),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (eve_session_id, eve_turn_id)
);

create index if not exists agent_runs_workspace_idx
  on public.agent_runs (workspace_id, started_at desc);
create index if not exists agent_runs_thread_idx
  on public.agent_runs (thread_id, started_at desc);

drop trigger if exists set_agent_runs_updated_at on public.agent_runs;
create trigger set_agent_runs_updated_at
  before update on public.agent_runs
  for each row execute function public.set_updated_at();

create table if not exists public.tool_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid references public.agent_runs (id) on delete cascade,
  thread_id uuid references public.threads (id) on delete set null,
  call_id text not null,
  tool_name text not null,
  input jsonb,
  output jsonb,
  status text not null check (status in
    ('requested', 'awaiting_approval', 'running', 'succeeded', 'failed', 'denied')),
  risk text not null default 'read'
    check (risk in ('read', 'prepare', 'execute_with_approval', 'autonomous')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (run_id, call_id)
);

create index if not exists tool_calls_workspace_idx
  on public.tool_calls (workspace_id, started_at desc);
create index if not exists tool_calls_thread_idx
  on public.tool_calls (thread_id, started_at desc);

-- ------------------------------------------------------------------- RLS

alter table public.agent_runs enable row level security;
alter table public.tool_calls enable row level security;

-- The renamed tables keep their 0002 policies; only this one's name is stale.
alter policy "workspace conversations" on public.threads rename to "workspace threads";

drop policy if exists "workspace agent_runs" on public.agent_runs;
create policy "workspace agent_runs" on public.agent_runs
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace tool_calls" on public.tool_calls;
create policy "workspace tool_calls" on public.tool_calls
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
