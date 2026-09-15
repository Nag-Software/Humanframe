-- The effect ledger.
--
-- A delivery is at-least-once, and that is only tolerable because an action is
-- not. Every effect Maya performs is claimed here first, under a key derived
-- from the business subject — `commitment:<id>:wake:<seq>:action:<name>`, never
-- a uuid, a timestamp or an attempt counter — so a wake that arrives twice
-- cannot run the same effect twice.
--
-- The row follows the same discipline as a delivery: claimed under a lease
-- before the effect runs, completed after. A crashed effect becomes eligible
-- again when its lease expires; a completed one never runs again.

create table if not exists public.effects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid,
  subject_type text not null
    check (subject_type in ('commitment', 'task', 'approval')),
  subject_id uuid not null,
  name text not null,
  idempotency_key text not null,
  state text not null default 'claimed'
    check (state in ('claimed', 'succeeded', 'failed')),
  attempts int not null default 0,
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  error jsonb,
  lease_token uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  constraint effects_assistant_fk
    foreign key (assistant_id, workspace_id)
    references public.assistants (id, workspace_id) on delete set null
);

create index if not exists effects_subject_idx
  on public.effects (workspace_id, subject_type, subject_id);

drop trigger if exists set_effects_updated_at on public.effects;
create trigger set_effects_updated_at before update on public.effects
  for each row execute function public.set_updated_at();

alter table public.effects enable row level security;

drop policy if exists "workspace effects" on public.effects;
create policy "workspace effects" on public.effects
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Claim an effect for execution. Returns a row only to the caller that may run
-- it: a fresh key, or one whose previous attempt died and left an expired
-- lease. A succeeded effect never returns a row again.
create or replace function public.claim_effect(
  p_workspace_id uuid,
  p_assistant_id uuid,
  p_subject_type text,
  p_subject_id uuid,
  p_name text,
  p_idempotency_key text,
  p_input jsonb,
  p_lease_ms int
)
returns setof public.effects
language plpgsql
volatile
security invoker
set search_path = public
as $$
begin
  insert into public.effects as e (
    workspace_id, assistant_id, subject_type, subject_id, name,
    idempotency_key, input, state, attempts, lease_token, lease_until)
  values (
    p_workspace_id, p_assistant_id, p_subject_type, p_subject_id, p_name,
    p_idempotency_key, coalesce(p_input, '{}'::jsonb), 'claimed', 1,
    gen_random_uuid(), now() + make_interval(secs => p_lease_ms / 1000.0))
  on conflict (workspace_id, idempotency_key) do update
     set attempts = e.attempts + 1,
         lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         updated_at = now()
   where e.state = 'claimed'
     and (e.lease_until is null or e.lease_until < now());

  return query
    select * from public.effects
     where workspace_id = p_workspace_id
       and idempotency_key = p_idempotency_key
       and state = 'claimed'
       and lease_until > now();
end;
$$;

revoke all on function public.claim_effect(uuid, uuid, text, uuid, text, text, jsonb, int)
  from public, anon, authenticated;
grant execute on function public.claim_effect(uuid, uuid, text, uuid, text, text, jsonb, int)
  to service_role;
