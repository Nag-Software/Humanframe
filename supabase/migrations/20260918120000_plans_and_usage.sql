-- Plans, included minutes and overage.
--
-- Humanframe has no free plan. Every workspace is on Starter or Pro; each
-- plan includes a number of call and FaceTime minutes a month, and what is
-- used beyond them is counted in money. Whether Maya may go beyond the plan
-- at all is the workspace's own choice, made in Settings.

-- 1. Plan names. Every workspace that was "free" is now on Starter.
alter table public.workspaces drop constraint if exists workspaces_plan_check;
update public.workspaces set plan = 'starter' where plan = 'free';
alter table public.workspaces
  alter column plan set default 'starter',
  add constraint workspaces_plan_check check (plan in ('starter', 'pro'));

alter table public.subscriptions drop constraint if exists subscriptions_plan_check;
update public.subscriptions set plan = 'starter' where plan = 'free';
alter table public.subscriptions
  add constraint subscriptions_plan_check check (plan in ('starter', 'pro'));

-- 2. What kind of call a session was, and how long the server agreed to
--    serve it. `allowed_seconds` is decided at start from the plan, the
--    minutes already used and the overage setting; null means only the
--    global ceiling applies.
alter table public.call_sessions
  add column if not exists kind text not null default 'voice'
    check (kind in ('voice', 'video')),
  add column if not exists allowed_seconds integer
    check (allowed_seconds is null or allowed_seconds > 0);

create index if not exists call_sessions_usage_idx
  on public.call_sessions (workspace_id, kind, started_at desc);

-- 3. The overage decision. One row per workspace; absent means "no".
create table if not exists public.usage_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  allow_overage boolean not null default false,
  -- A monthly ceiling on overage, in cents. Null means no ceiling.
  overage_cap_cents integer check (overage_cap_cents is null or overage_cap_cents >= 0),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_usage_settings_updated_at on public.usage_settings;
create trigger set_usage_settings_updated_at before update on public.usage_settings
  for each row execute function public.set_updated_at();

alter table public.usage_settings enable row level security;

-- Every member can see the setting; only an owner or admin can change what
-- the workspace is willing to pay.
drop policy if exists "members read usage settings" on public.usage_settings;
create policy "members read usage settings" on public.usage_settings
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "admins write usage settings" on public.usage_settings;
create policy "admins write usage settings" on public.usage_settings
  for all to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
