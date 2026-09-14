-- Least privilege for the helper functions.
--
-- Supabase grants EXECUTE on public functions to anon, authenticated and
-- service_role by default, which exposes every SECURITY DEFINER function as an
-- RPC endpoint. Only the two functions the app and the policies actually need
-- stay callable, and only for signed-in users.

alter function public.set_updated_at() set search_path = public;
alter function public.workspace_id_from_object_name(text) set search_path = public;

-- Internal: called by the signup trigger and by ensure_user_bootstrap().
revoke execute on function public.provision_user(uuid) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Trigger-only.
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- Policy helpers: signed-in users must be able to run them, anon must not.
revoke execute on function public.is_workspace_member(uuid) from public, anon;
revoke execute on function public.has_workspace_role(uuid, public.workspace_role[]) from public, anon;
revoke execute on function public.workspace_id_from_object_name(text) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated;
grant execute on function public.workspace_id_from_object_name(text) to authenticated;

-- App entry point, right after sign-in.
revoke execute on function public.ensure_user_bootstrap() from public, anon;
grant execute on function public.ensure_user_bootstrap() to authenticated;
