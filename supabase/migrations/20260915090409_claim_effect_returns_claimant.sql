-- claim_effect returned a row to callers that had not claimed anything.
--
-- The first version ran the upsert, then selected any row in `claimed` with a
-- live lease. When a second caller arrived while the first still held the
-- lease, the DO UPDATE's WHERE correctly refused the update — and then the
-- trailing SELECT matched the *first* caller's live row and handed it over, so
-- both callers ran the effect.
--
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING only returns rows actually
-- inserted or updated, so the claim is the statement's own result. A caller
-- that did not claim now gets nothing.

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
language sql
volatile
security invoker
set search_path = public
as $$
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
     and (e.lease_until is null or e.lease_until < now())
  returning e.*;
$$;

revoke all on function public.claim_effect(uuid, uuid, text, uuid, text, text, jsonb, int)
  from public, anon, authenticated;
grant execute on function public.claim_effect(uuid, uuid, text, uuid, text, text, jsonb, int)
  to service_role;
