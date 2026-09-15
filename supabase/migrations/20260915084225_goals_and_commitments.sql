-- Phase 4: goals, commitments, deliveries, tasks and the business event log.
--
-- Two rules shape this migration:
--   1. The runtime writes with the service role, which bypasses RLS. Tenancy
--      on that path therefore has to be a constraint, not a policy, so every
--      cross-table reference is a composite (id, workspace_id) foreign key.
--   2. A commitment's wake is claimed, not polled. The claim is the only piece
--      of logic that has to be atomic, so it is the only new SQL function.

-- ---------------------------------------------------------------------------
-- Composite identities, so a foreign key can carry the workspace with it.
-- ---------------------------------------------------------------------------

alter table public.threads
  add constraint threads_id_workspace_key unique (id, workspace_id);
alter table public.assistants
  add constraint assistants_id_workspace_key unique (id, workspace_id);

-- ---------------------------------------------------------------------------
-- thread_sessions: a thread is one conversation, but it may outlive an eve
-- session. threads.eve_session_id stays the current session; this is the full
-- history, so a recovered session projects into the thread it belongs to
-- instead of opening a second public conversation.
-- ---------------------------------------------------------------------------

create table if not exists public.thread_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  thread_id uuid not null,
  eve_session_id text not null unique,
  reason text not null default 'initial'
    check (reason in ('initial', 'wake_recovery')),
  created_at timestamptz not null default now(),
  constraint thread_sessions_thread_fk
    foreign key (thread_id, workspace_id)
    references public.threads (id, workspace_id) on delete cascade
);

create index if not exists thread_sessions_thread_idx
  on public.thread_sessions (thread_id, created_at desc);

-- Backfill the sessions threads already own.
insert into public.thread_sessions (workspace_id, thread_id, eve_session_id, reason)
select t.workspace_id, t.id, t.eve_session_id, 'initial'
from public.threads t
where t.eve_session_id is not null
on conflict (eve_session_id) do nothing;

-- ---------------------------------------------------------------------------
-- goals: standing intent, no deadline.
-- ---------------------------------------------------------------------------

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid not null,
  user_id uuid references auth.users (id) on delete set null,
  title text not null,
  detail text,
  status text not null default 'active'
    check (status in ('active', 'paused', 'achieved', 'dropped')),
  priority real not null default 0.5 check (priority between 0 and 1),
  target_date date,
  source_thread_id uuid,
  source_message_id uuid,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, assistant_id, dedupe_key),
  constraint goals_id_workspace_key unique (id, workspace_id),
  constraint goals_assistant_fk
    foreign key (assistant_id, workspace_id)
    references public.assistants (id, workspace_id) on delete cascade,
  constraint goals_source_thread_fk
    foreign key (source_thread_id, workspace_id)
    references public.threads (id, workspace_id) on delete set null
);

create index if not exists goals_lookup_idx
  on public.goals (workspace_id, assistant_id, status, priority desc);

drop trigger if exists set_goals_updated_at on public.goals;
create trigger set_goals_updated_at before update on public.goals
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- commitments: a promise with a deadline. Retry state lives on the delivery,
-- not here, so that a retry can never change a reminder's identity.
-- ---------------------------------------------------------------------------

create table if not exists public.commitments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid not null,
  user_id uuid references auth.users (id) on delete set null,
  goal_id uuid,
  thread_id uuid not null,
  title text not null,
  detail text,
  kind text not null default 'follow_up'
    check (kind in ('follow_up', 'remind', 'deliver')),
  owner text not null default 'assistant'
    check (owner in ('user', 'assistant')),
  due_at timestamptz not null,
  due_timezone text not null default 'UTC',
  status text not null default 'scheduled'
    check (status in ('scheduled', 'waking', 'delivered', 'in_progress',
                      'waiting_approval', 'done', 'cancelled', 'failed')),
  wake_seq int not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  last_error jsonb,
  source_thread_id uuid,
  source_message_id uuid,
  dedupe_key text not null,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, assistant_id, dedupe_key),
  constraint commitments_id_workspace_key unique (id, workspace_id),
  constraint commitments_assistant_fk
    foreign key (assistant_id, workspace_id)
    references public.assistants (id, workspace_id) on delete cascade,
  constraint commitments_thread_fk
    foreign key (thread_id, workspace_id)
    references public.threads (id, workspace_id) on delete cascade,
  constraint commitments_goal_fk
    foreign key (goal_id, workspace_id)
    references public.goals (id, workspace_id) on delete set null,
  constraint commitments_source_thread_fk
    foreign key (source_thread_id, workspace_id)
    references public.threads (id, workspace_id) on delete set null
);

create index if not exists commitments_due_idx
  on public.commitments (due_at)
  where status in ('scheduled', 'waking');
create index if not exists commitments_lookup_idx
  on public.commitments (workspace_id, assistant_id, due_at desc);

drop trigger if exists set_commitments_updated_at on public.commitments;
create trigger set_commitments_updated_at before update on public.commitments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- commitment_deliveries: one row per logical reminder. The row id is the
-- delivery_id and is stable across every retry; `attempts` counts retries and
-- carries no identity.
-- ---------------------------------------------------------------------------

create table if not exists public.commitment_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  commitment_id uuid not null,
  wake_seq int not null,
  state text not null default 'pending'
    check (state in ('pending', 'sent', 'confirmed', 'abandoned')),
  attempts int not null default 0,
  next_attempt_at timestamptz,
  target_session_id text,
  target_kind text
    check (target_kind in ('existing_session', 'new_session')),
  marker text not null,
  last_error jsonb,
  abandoned_reason text,
  sent_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (commitment_id, wake_seq),
  unique (marker),
  constraint commitment_deliveries_commitment_fk
    foreign key (commitment_id, workspace_id)
    references public.commitments (id, workspace_id) on delete cascade
);

create index if not exists commitment_deliveries_pending_idx
  on public.commitment_deliveries (state, next_attempt_at)
  where state in ('pending', 'sent');

drop trigger if exists set_commitment_deliveries_updated_at
  on public.commitment_deliveries;
create trigger set_commitment_deliveries_updated_at
  before update on public.commitment_deliveries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- tasks: one unit of background work.
-- ---------------------------------------------------------------------------

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid not null,
  thread_id uuid not null,
  commitment_id uuid,
  goal_id uuid,
  title text not null,
  input jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting_input', 'waiting_approval',
                      'succeeded', 'failed', 'cancelled')),
  result jsonb,
  error jsonb,
  eve_session_id text,
  eve_task_id text,
  eve_call_id text,
  workflow_run_id text,
  idempotency_key text not null,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  constraint tasks_id_workspace_key unique (id, workspace_id),
  constraint tasks_assistant_fk
    foreign key (assistant_id, workspace_id)
    references public.assistants (id, workspace_id) on delete cascade,
  constraint tasks_thread_fk
    foreign key (thread_id, workspace_id)
    references public.threads (id, workspace_id) on delete cascade,
  constraint tasks_commitment_fk
    foreign key (commitment_id, workspace_id)
    references public.commitments (id, workspace_id) on delete set null,
  constraint tasks_goal_fk
    foreign key (goal_id, workspace_id)
    references public.goals (id, workspace_id) on delete set null
);

create index if not exists tasks_lookup_idx
  on public.tasks (workspace_id, assistant_id, status, created_at desc);

drop trigger if exists set_tasks_updated_at on public.tasks;
create trigger set_tasks_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- events: the business timeline. One row per business transition — never a
-- copy of eve's event stream. Every writer supplies a deterministic key.
-- ---------------------------------------------------------------------------

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid,
  subject_type text not null
    check (subject_type in ('goal', 'commitment', 'delivery', 'task', 'approval')),
  subject_id uuid not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  thread_id uuid,
  eve_session_id text,
  eve_turn_id text,
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  constraint events_assistant_fk
    foreign key (assistant_id, workspace_id)
    references public.assistants (id, workspace_id) on delete set null,
  constraint events_thread_fk
    foreign key (thread_id, workspace_id)
    references public.threads (id, workspace_id) on delete set null
);

create index if not exists events_subject_idx
  on public.events (workspace_id, subject_type, subject_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Why a run happened. agent_runs stays a projection: status, timing, cost and
-- the references needed to find the real log in Vercel.
-- ---------------------------------------------------------------------------

alter table public.agent_runs
  add column if not exists origin text not null default 'user'
    check (origin in ('user', 'schedule', 'task', 'approval'));

-- The timezone a relative deadline like "Friday" is resolved in.
alter table public.workspace_members
  add column if not exists timezone text;

-- ---------------------------------------------------------------------------
-- The claim. The only atomic piece, and the only path that may start a wake.
--
-- It claims due commitments that are 'scheduled', and re-claims 'waking' rows
-- whose lease has expired — a worker that crashed mid-delivery strands its row
-- in 'waking', and without that branch the reminder would never fire again.
-- A recovered row keeps its wake_seq, and therefore its delivery identity; a
-- freshly claimed row opens a new logical reminder.
-- ---------------------------------------------------------------------------

create or replace function public.claim_commitments_for_wake(
  p_limit int,
  p_lease_ms int,
  p_id uuid default null
)
returns setof public.commitments
language sql
volatile
security invoker
set search_path = public
as $$
  update public.commitments c
     set status = 'waking',
         lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         wake_seq = c.wake_seq
           + case when c.status = 'waking' then 0 else 1 end,
         updated_at = now()
   where c.id in (
     select id
       from public.commitments
      where status in ('scheduled', 'waking')
        and due_at <= now()
        and (lease_until is null or lease_until < now())
        and (p_id is null or id = p_id)
      order by due_at
      limit greatest(p_limit, 0)
      for update skip locked
   )
  returning c.*;
$$;

revoke all on function public.claim_commitments_for_wake(int, int, uuid) from public;
grant execute on function public.claim_commitments_for_wake(int, int, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- RLS. The runtime uses the service role and is constrained by the composite
-- foreign keys above; these policies are what protect the browser path.
-- ---------------------------------------------------------------------------

alter table public.thread_sessions enable row level security;
alter table public.goals enable row level security;
alter table public.commitments enable row level security;
alter table public.commitment_deliveries enable row level security;
alter table public.tasks enable row level security;
alter table public.events enable row level security;

drop policy if exists "workspace thread_sessions" on public.thread_sessions;
create policy "workspace thread_sessions" on public.thread_sessions
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace goals" on public.goals;
create policy "workspace goals" on public.goals
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace commitments" on public.commitments;
create policy "workspace commitments" on public.commitments
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace commitment_deliveries" on public.commitment_deliveries;
create policy "workspace commitment_deliveries" on public.commitment_deliveries
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace tasks" on public.tasks;
create policy "workspace tasks" on public.tasks
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace events" on public.events;
create policy "workspace events" on public.events
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
