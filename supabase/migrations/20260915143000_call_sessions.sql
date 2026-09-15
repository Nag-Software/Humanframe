-- ---------------------------------------------------------------------------
-- Phase 5: Call.
--
-- Provider-neutral on purpose. The provider is a column, never a schema: a
-- Tavus call in phase 6 writes the same two tables with provider = 'tavus',
-- and every consumer downstream — messages, memory, commitments — keeps
-- working without knowing which one produced the turn.
--
-- The provider's own session id is internal. It lives here, next to the call,
-- and is deliberately not `threads.eve_session_id`: a call is not an eve
-- session, and conflating the two would let a call hijack a chat thread.
-- ---------------------------------------------------------------------------

create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid not null,
  thread_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('openai_realtime', 'tavus')),
  -- Internal identifier, never rendered and never accepted from a client.
  provider_call_id text,
  model text,
  status text not null default 'connecting'
    check (status in ('connecting', 'active', 'ended', 'failed')),
  end_reason text,
  turn_count integer not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Tenancy on the service-role path: the composite references make it
  -- impossible to point a call at another workspace's assistant or thread,
  -- whatever a caller claims.
  constraint call_sessions_assistant_fkey
    foreign key (assistant_id, workspace_id)
    references public.assistants (id, workspace_id) on delete cascade,
  constraint call_sessions_thread_fkey
    foreign key (thread_id, workspace_id)
    references public.threads (id, workspace_id) on delete cascade,
  constraint call_sessions_id_workspace_key unique (id, workspace_id)
);

create unique index if not exists call_sessions_provider_call_idx
  on public.call_sessions (workspace_id, provider, provider_call_id)
  where provider_call_id is not null;

create index if not exists call_sessions_user_recent_idx
  on public.call_sessions (user_id, started_at desc);

create index if not exists call_sessions_live_idx
  on public.call_sessions (workspace_id, status)
  where status in ('connecting', 'active');

drop trigger if exists set_call_sessions_updated_at on public.call_sessions;
create trigger set_call_sessions_updated_at before update on public.call_sessions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- One finished spoken turn, normalised.
--
-- This is the small internal representation the transcript path speaks: a
-- role, some text, and whether the user actually heard all of it. Partial
-- transcripts never reach it — only a turn the provider has declared done.
-- `source_id` is namespaced by the call, so two providers' item ids cannot
-- collide even if they choose the same string.
-- ---------------------------------------------------------------------------

create table if not exists public.call_turns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  call_session_id uuid not null,
  provider text not null,
  source_id text not null,
  role text not null check (role in ('user', 'assistant')),
  text text not null,
  -- 'interrupted': the model generated this, but the user cut it off partway.
  -- Unheard words must never be treated as delivered, so everything that reads
  -- transcripts downstream filters on this.
  status text not null check (status in ('completed', 'interrupted')),
  message_id uuid,
  -- The first time this turn was seen. It is the message's created_at too,
  -- which is what makes a replayed write land on the same row.
  first_seen_at timestamptz not null default now(),

  constraint call_turns_session_fkey
    foreign key (call_session_id, workspace_id)
    references public.call_sessions (id, workspace_id) on delete cascade,
  constraint call_turns_source_key unique (call_session_id, source_id)
);

create index if not exists call_turns_session_idx
  on public.call_turns (call_session_id, first_seen_at);

-- ---------------------------------------------------------------------------
-- Persisting a turn: the call_turns row and its message projection, together.
--
-- The call_turns row is the idempotency anchor. It carries the timestamp the
-- message is written with, so a retry — a repeated data channel event, a
-- reconnect, a second flush at hang-up — conflicts on the same key and returns
-- the row that already exists rather than writing a second message.
-- ---------------------------------------------------------------------------

create or replace function public.record_call_turn(
  p_workspace_id uuid,
  p_call_session_id uuid,
  p_source_id text,
  p_role text,
  p_text text,
  p_status text
)
returns table (turn_id uuid, message_id uuid, created boolean)
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_turn public.call_turns%rowtype;
  v_call public.call_sessions%rowtype;
  v_message_id uuid;
  v_created boolean := false;
  v_source text;
begin
  select * into v_call
    from public.call_sessions
   where id = p_call_session_id and workspace_id = p_workspace_id;

  if not found then
    raise exception 'call session % not found in workspace %',
      p_call_session_id, p_workspace_id;
  end if;

  insert into public.call_turns as t (
    workspace_id, call_session_id, provider, source_id, role, text, status)
  values (
    p_workspace_id, p_call_session_id, v_call.provider, p_source_id, p_role,
    p_text, p_status)
  on conflict (call_session_id, source_id) do nothing
  returning * into v_turn;

  if v_turn.id is null then
    select * into v_turn
      from public.call_turns
     where call_session_id = p_call_session_id and source_id = p_source_id;
    return query select v_turn.id, v_turn.message_id, false;
    return;
  end if;

  v_created := true;

  -- An empty turn is real (a cut-off answer that never said a word) but there
  -- is nothing to show, so it is recorded without a message.
  if length(btrim(p_text)) > 0 then
    v_source := 'call:' || v_call.provider || ':' || p_source_id;

    insert into public.messages as m (
      workspace_id, assistant_id, thread_id, channel, role, content, metadata,
      source_message_id, created_at)
    values (
      p_workspace_id, v_call.assistant_id, v_call.thread_id, 'live', p_role,
      jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text)),
      jsonb_build_object(
        'call', jsonb_build_object(
          'callSessionId', p_call_session_id,
          'provider', v_call.provider,
          'interrupted', p_status = 'interrupted')),
      v_source, v_turn.first_seen_at)
    on conflict (thread_id, source_message_id, created_at) do nothing
    returning m.id into v_message_id;

    if v_message_id is null then
      select id into v_message_id
        from public.messages
       where thread_id = v_call.thread_id
         and source_message_id = v_source
         and created_at = v_turn.first_seen_at;
    end if;

    update public.call_turns set message_id = v_message_id where id = v_turn.id;
  end if;

  update public.call_sessions
     set turn_count = turn_count + 1,
         status = case when status = 'connecting' then 'active' else status end,
         updated_at = now()
   where id = p_call_session_id;

  update public.threads
     set last_message_at = greatest(last_message_at, v_turn.first_seen_at)
   where id = v_call.thread_id;

  return query select v_turn.id, v_message_id, v_created;
end;
$$;

-- Supabase grants EXECUTE to anon and authenticated by name, so revoking from
-- public is not enough: a browser client must not be able to write transcripts.
revoke all on function public.record_call_turn(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_call_turn(uuid, uuid, text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Row level security. A browser may read its own calls and nothing else: every
-- write goes through a server route that has already verified the caller.
-- ---------------------------------------------------------------------------

alter table public.call_sessions enable row level security;
alter table public.call_turns enable row level security;

drop policy if exists "read own call sessions" on public.call_sessions;
create policy "read own call sessions" on public.call_sessions
  for select to authenticated
  using (public.is_workspace_member(workspace_id) and user_id = auth.uid());

drop policy if exists "read own call turns" on public.call_turns;
create policy "read own call turns" on public.call_turns
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.call_sessions c
       where c.id = call_turns.call_session_id
         and c.workspace_id = call_turns.workspace_id
         and c.user_id = auth.uid()
    )
  );
