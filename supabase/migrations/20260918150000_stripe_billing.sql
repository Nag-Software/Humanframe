-- Stripe: the customer, the subscription as Stripe sees it, the events we
-- have already handled, and the overage each call was reported for.

-- The customer belongs to the workspace and exists before any subscription.
alter table public.workspaces
  add column if not exists stripe_customer_id text;
create unique index if not exists workspaces_stripe_customer_idx
  on public.workspaces (stripe_customer_id)
  where stripe_customer_id is not null;

-- What Stripe knows about the subscription, mirrored by the webhook.
alter table public.subscriptions drop constraint if exists subscriptions_status_check;
alter table public.subscriptions
  add constraint subscriptions_status_check check (status in (
    'trialing', 'active', 'past_due', 'canceled', 'unpaid',
    'incomplete', 'incomplete_expired', 'paused'
  )),
  add column if not exists current_period_start timestamptz,
  add column if not exists billing_interval text
    check (billing_interval is null or billing_interval in ('month', 'year')),
  add column if not exists stripe_price_id text,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists trial_end timestamptz,
  -- A workspace gets the $1-a-day trial once.
  add column if not exists trial_used boolean not null default false;

create unique index if not exists subscriptions_stripe_subscription_idx
  on public.subscriptions (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- Every Stripe event is handled once. Service role only: no policies.
create table if not exists public.billing_events (
  id text primary key,
  type text not null,
  workspace_id uuid references public.workspaces (id) on delete set null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);
alter table public.billing_events enable row level security;

-- The seconds beyond the plan that a call was reported to Stripe for. Written
-- once per call, so a retried report cannot bill the same minutes twice.
alter table public.call_sessions
  add column if not exists overage_seconds integer not null default 0
    check (overage_seconds >= 0),
  add column if not exists overage_reported_at timestamptz;
