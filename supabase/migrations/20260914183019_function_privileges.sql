alter function public.set_updated_at() set search_path = public;
alter function public.workspace_id_from_object_name(text) set search_path = public;

revoke execute on function public.provision_user(uuid) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

revoke execute on function public.is_workspace_member(uuid) from public, anon;
revoke execute on function public.has_workspace_role(uuid, public.workspace_role[]) from public, anon;
revoke execute on function public.workspace_id_from_object_name(text) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated;
grant execute on function public.workspace_id_from_object_name(text) to authenticated;

revoke execute on function public.ensure_user_bootstrap() from public, anon;
grant execute on function public.ensure_user_bootstrap() to authenticated;;
