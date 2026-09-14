-- Billing belongs to the workspace, not the user.
--
-- `workspaces.plan` is the cheap, always-available read the UI uses to show
-- the current tier. `subscriptions` is the Stripe-shaped source of truth
-- that a webhook keeps in sync; `plan` is denormalized from it so pages that
-- only need the tier name don't have to join.

alter table public.workspaces
  add column if not exists plan text not null default 'free'
    check (plan in ('free', 'pro'));

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  status text not null
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  plan text not null check (plan in ('free', 'pro')),
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id)
);

create index if not exists subscriptions_stripe_customer_idx
  on public.subscriptions (stripe_customer_id)
  where stripe_customer_id is not null;

drop trigger if exists set_subscriptions_updated_at on public.subscriptions;
create trigger set_subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;

drop policy if exists "members read subscription" on public.subscriptions;
create policy "members read subscription" on public.subscriptions
  for select to authenticated using (public.is_workspace_member(workspace_id));

-- Written only by the Stripe webhook, which uses the service role and so
-- bypasses RLS; no authenticated-write policy is defined here on purpose.
