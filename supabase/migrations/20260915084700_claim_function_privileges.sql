-- `revoke ... from public` is not enough on Supabase: the default privileges
-- for the postgres role grant EXECUTE on new functions in `public` to anon,
-- authenticated and service_role directly, so those grants survive a revoke
-- aimed at PUBLIC. The claim starts a wake and hands out a lease; only the
-- runtime may call it.

revoke all on function public.claim_commitments_for_wake(int, int, uuid)
  from anon, authenticated;

grant execute on function public.claim_commitments_for_wake(int, int, uuid)
  to service_role;
