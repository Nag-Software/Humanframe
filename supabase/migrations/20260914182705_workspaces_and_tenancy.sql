create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  locale text not null default 'no',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_type where typname = 'workspace_role') then
    create type public.workspace_role as enum ('owner', 'admin', 'member');
  end if;
end
$$;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  is_personal boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.workspace_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx
  on public.workspace_members (user_id);

create table if not exists public.assistants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  slug text not null,
  name text not null,
  role text,
  instructions text,
  status text not null default 'active'
    check (status in ('active', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

drop trigger if exists set_users_updated_at on public.users;
create trigger set_users_updated_at before update on public.users
  for each row execute function public.set_updated_at();

drop trigger if exists set_workspaces_updated_at on public.workspaces;
create trigger set_workspaces_updated_at before update on public.workspaces
  for each row execute function public.set_updated_at();

drop trigger if exists set_assistants_updated_at on public.assistants;
create trigger set_assistants_updated_at before update on public.assistants
  for each row execute function public.set_updated_at();

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.has_workspace_role(
  target_workspace uuid,
  allowed public.workspace_role[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
      and m.role = any(allowed)
  );
$$;

revoke execute on function public.is_workspace_member(uuid) from public;
revoke execute on function public.has_workspace_role(uuid, public.workspace_role[]) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_slug text;
  new_workspace_id uuid;
  display_name text;
begin
  display_name := coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    split_part(coalesce(new.email, ''), '@', 1),
    'Workspace'
  );

  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(excluded.full_name, public.users.full_name);

  base_slug := trim(both '-' from regexp_replace(
    lower(coalesce(nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'workspace')),
    '[^a-z0-9]+', '-', 'g'
  ));
  if base_slug = '' then
    base_slug := 'workspace';
  end if;

  insert into public.workspaces (name, slug, is_personal, created_by)
  values (
    display_name,
    base_slug || '-' || substr(replace(new.id::text, '-', ''), 1, 8),
    true,
    new.id
  )
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');

  insert into public.assistants (workspace_id, slug, name, role)
  values (new_workspace_id, 'maya', 'Maya', 'Chief of Staff');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop policy if exists "own conversations" on public.maya_conversations;
drop policy if exists "own messages" on public.maya_messages;
drop policy if exists "own attachments" on public.maya_attachments;

alter table public.maya_conversations
  add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade,
  add column if not exists assistant_id uuid references public.assistants (id) on delete set null,
  add column if not exists created_by uuid references auth.users (id) on delete set null;

alter table public.maya_messages
  add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;

alter table public.maya_attachments
  add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;

update public.maya_conversations c
set workspace_id = m.workspace_id,
    created_by = coalesce(c.created_by, c.user_id)
from public.workspace_members m
where c.workspace_id is null
  and c.user_id is not null
  and m.user_id = c.user_id;

update public.maya_messages msg
set workspace_id = c.workspace_id
from public.maya_conversations c
where msg.workspace_id is null
  and msg.conversation_id = c.id;

update public.maya_attachments a
set workspace_id = c.workspace_id
from public.maya_conversations c
where a.workspace_id is null
  and a.conversation_id = c.id;

delete from public.maya_attachments where workspace_id is null;
delete from public.maya_messages where workspace_id is null;
delete from public.maya_conversations where workspace_id is null;

alter table public.maya_conversations alter column workspace_id set not null;
alter table public.maya_messages alter column workspace_id set not null;
alter table public.maya_attachments alter column workspace_id set not null;

alter table public.maya_conversations drop column if exists user_id;

create index if not exists maya_conversations_workspace_idx
  on public.maya_conversations (workspace_id, updated_at desc);
create index if not exists maya_messages_workspace_idx
  on public.maya_messages (workspace_id);
create index if not exists maya_attachments_workspace_idx
  on public.maya_attachments (workspace_id);

drop trigger if exists set_maya_conversations_updated_at on public.maya_conversations;
create trigger set_maya_conversations_updated_at
  before update on public.maya_conversations
  for each row execute function public.set_updated_at();

alter table public.users enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.assistants enable row level security;
alter table public.maya_conversations enable row level security;
alter table public.maya_messages enable row level security;
alter table public.maya_attachments enable row level security;

drop policy if exists "read own profile" on public.users;
create policy "read own profile" on public.users
  for select to authenticated using (id = auth.uid());
drop policy if exists "update own profile" on public.users;
create policy "update own profile" on public.users
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "read member workspaces" on public.workspaces;
create policy "read member workspaces" on public.workspaces
  for select to authenticated using (public.is_workspace_member(id));
drop policy if exists "admins update workspace" on public.workspaces;
create policy "admins update workspace" on public.workspaces
  for update to authenticated
  using (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]));

drop policy if exists "read own memberships" on public.workspace_members;
create policy "read own memberships" on public.workspace_members
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists "owners manage memberships" on public.workspace_members;
create policy "owners manage memberships" on public.workspace_members
  for all to authenticated
  using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

drop policy if exists "members read assistants" on public.assistants;
create policy "members read assistants" on public.assistants
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists "admins write assistants" on public.assistants;
create policy "admins write assistants" on public.assistants
  for all to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

drop policy if exists "workspace conversations" on public.maya_conversations;
create policy "workspace conversations" on public.maya_conversations
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace messages" on public.maya_messages;
create policy "workspace messages" on public.maya_messages
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace attachments" on public.maya_attachments;
create policy "workspace attachments" on public.maya_attachments
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

update storage.buckets set public = false where id = 'maya-attachments';

create or replace function public.workspace_id_from_object_name(object_name text)
returns uuid
language sql
immutable
as $$
  select case
    when split_part(object_name, '/', 1) ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(object_name, '/', 1)::uuid
    else null
  end;
$$;

drop policy if exists "workspace attachment objects" on storage.objects;
create policy "workspace attachment objects" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'maya-attachments'
    and public.is_workspace_member(public.workspace_id_from_object_name(name))
  )
  with check (
    bucket_id = 'maya-attachments'
    and public.is_workspace_member(public.workspace_id_from_object_name(name))
  );
;
