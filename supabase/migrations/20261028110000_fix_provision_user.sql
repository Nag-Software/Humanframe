-- ---------------------------------------------------------------------------
-- Fix sign-up: provision_user declared a variable named `workspace_id`, the
-- same name as the column in `on conflict (workspace_id, user_id)` and
-- `on conflict (workspace_id, slug)`. PL/pgSQL refuses that as ambiguous
-- (42702), so the signup trigger on auth.users failed and Supabase answered
-- every new email sign-in with "Database error saving new user"; the
-- ensure_user_bootstrap() fallback failed the same way.
--
-- Same function, the variable renamed. Privileges are unchanged by
-- CREATE OR REPLACE, but are restated so this file stands on its own.
-- ---------------------------------------------------------------------------

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
  v_workspace_id uuid;
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

  select m.workspace_id into v_workspace_id
  from public.workspace_members m
  where m.user_id = auth_user.id
  order by m.created_at asc
  limit 1;

  if v_workspace_id is null then
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
    returning id into v_workspace_id;

    insert into public.workspace_members (workspace_id, user_id, role)
    values (v_workspace_id, auth_user.id, 'owner')
    on conflict (workspace_id, user_id) do nothing;
  end if;

  insert into public.assistants (workspace_id, slug, name, role)
  values (v_workspace_id, 'maya', 'Maya', 'Chief of Staff')
  on conflict (workspace_id, slug) do nothing;

  return v_workspace_id;
end;
$$;

revoke execute on function public.provision_user(uuid) from public, anon, authenticated;
