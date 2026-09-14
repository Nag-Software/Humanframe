create or replace function public.provision_user(target_user uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  auth_user record;
  base_slug text;
  display_name text;
  workspace_id uuid;
begin
  select id, email, raw_user_meta_data
    into auth_user
  from auth.users
  where id = target_user;

  if not found then
    raise exception 'Unknown user %', target_user;
  end if;

  display_name := coalesce(
    auth_user.raw_user_meta_data ->> 'full_name',
    auth_user.raw_user_meta_data ->> 'name',
    nullif(split_part(coalesce(auth_user.email, ''), '@', 1), ''),
    'Workspace'
  );

  insert into public.users (id, email, full_name, avatar_url)
  values (
    auth_user.id,
    auth_user.email,
    auth_user.raw_user_meta_data ->> 'full_name',
    auth_user.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email = coalesce(excluded.email, public.users.email),
        full_name = coalesce(excluded.full_name, public.users.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.users.avatar_url);

  select m.workspace_id into workspace_id
  from public.workspace_members m
  where m.user_id = auth_user.id
  order by m.created_at asc
  limit 1;

  if workspace_id is null then
    base_slug := trim(both '-' from regexp_replace(
      lower(coalesce(nullif(split_part(coalesce(auth_user.email, ''), '@', 1), ''), 'workspace')),
      '[^a-z0-9]+', '-', 'g'
    ));
    if base_slug = '' then
      base_slug := 'workspace';
    end if;

    insert into public.workspaces (name, slug, is_personal, created_by)
    values (
      display_name,
      base_slug || '-' || substr(replace(auth_user.id::text, '-', ''), 1, 8),
      true,
      auth_user.id
    )
    on conflict (slug) do update set slug = public.workspaces.slug
    returning id into workspace_id;

    insert into public.workspace_members (workspace_id, user_id, role)
    values (workspace_id, auth_user.id, 'owner')
    on conflict (workspace_id, user_id) do nothing;
  end if;

  insert into public.assistants (workspace_id, slug, name, role)
  values (workspace_id, 'maya', 'Maya', 'Chief of Staff')
  on conflict (workspace_id, slug) do nothing;

  return workspace_id;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.provision_user(new.id);
  return new;
end;
$$;

create or replace function public.ensure_user_bootstrap()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'No authenticated user';
  end if;
  return public.provision_user(caller);
end;
$$;

revoke execute on function public.provision_user(uuid) from public;
revoke execute on function public.ensure_user_bootstrap() from public;
grant execute on function public.ensure_user_bootstrap() to authenticated;
;
