import type { SupabaseClient } from "@supabase/supabase-js";

import { errorFields, logger } from "@/lib/logger";
import type { PlanId } from "@/lib/plans";
import {
  planForPrice,
  type BillingInterval,
  type PriceCatalog,
} from "@/server/billing/stripe";

/**
 * The subscription, as Humanframe keeps it.
 *
 * Stripe is the source of truth; this table is what the webhook mirrors it
 * into, so a page never has to call Stripe to know whether a workspace may
 * use Maya. `workspaces.plan` is denormalised from it for the same reason.
 */
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export type Subscription = {
  status: SubscriptionStatus;
  plan: PlanId;
  interval: BillingInterval | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  trialUsed: boolean;
};

/** What the UI needs, and nothing Stripe-shaped. */
export type SubscriptionSummary = {
  status: SubscriptionStatus | "none";
  plan: PlanId;
  interval: BillingInterval | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  trialAvailable: boolean;
  hasCustomer: boolean;
};

type Row = {
  status: SubscriptionStatus;
  plan: PlanId;
  billing_interval: BillingInterval | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  trial_end: string | null;
  trial_used: boolean;
};

const COLUMNS =
  "status, plan, billing_interval, stripe_customer_id, stripe_subscription_id, " +
  "stripe_price_id, current_period_start, current_period_end, " +
  "cancel_at_period_end, trial_end, trial_used";

/** May this workspace use Maya? Past due keeps working while Stripe retries. */
export function isEntitled(status: SubscriptionStatus | "none"): boolean {
  return status === "trialing" || status === "active" || status === "past_due";
}

export async function loadSubscription(
  client: SupabaseClient,
  workspaceId: string
): Promise<Subscription | null> {
  const { data } = await client
    .from("subscriptions")
    .select(COLUMNS)
    .eq("workspace_id", workspaceId)
    .maybeSingle<Row>();
  return data ? fromRow(data) : null;
}

export function summarize(
  subscription: Subscription | null,
  plan: PlanId,
  hasCustomer: boolean
): SubscriptionSummary {
  return {
    status: subscription?.status ?? "none",
    plan: subscription?.plan ?? plan,
    interval: subscription?.interval ?? null,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    trialEnd: subscription?.trialEnd ?? null,
    trialAvailable: !(subscription?.trialUsed ?? false),
    hasCustomer,
  };
}

/** The billing period Stripe is on, when there is one. */
export function billingPeriod(
  subscription: Subscription | null
): { start: Date; end: Date } | null {
  if (!subscription?.currentPeriodStart || !subscription.currentPeriodEnd) {
    return null;
  }
  return {
    start: new Date(subscription.currentPeriodStart),
    end: new Date(subscription.currentPeriodEnd),
  };
}

/**
 * The parts of a Stripe subscription this module reads. Structural, so the
 * mapper is testable with a plain object and survives SDK type churn: newer
 * API versions carry the period on the items rather than the subscription.
 */
export type StripeSubscriptionLike = {
  id: string;
  status: string;
  customer: string | { id: string };
  cancel_at_period_end: boolean;
  trial_end: number | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  items: {
    data: {
      price: { id: string };
      current_period_start?: number | null;
      current_period_end?: number | null;
    }[];
  };
  metadata?: Record<string, string>;
};

export type SubscriptionUpsert = {
  status: SubscriptionStatus;
  plan: PlanId;
  interval: BillingInterval;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
};

/** Pure: what a Stripe subscription means for us. Null when it carries no plan price. */
export function subscriptionFromStripe(
  subscription: StripeSubscriptionLike,
  catalog: Pick<PriceCatalog, "plans">
): SubscriptionUpsert | null {
  let planItem: { plan: PlanId; interval: BillingInterval; priceId: string; item: StripeSubscriptionLike["items"]["data"][number] } | null = null;
  for (const item of subscription.items.data) {
    const match = planForPrice(item.price.id, catalog);
    if (match) {
      planItem = { ...match, priceId: item.price.id, item };
      break;
    }
  }
  if (!planItem) {
    return null;
  }

  const seconds = (value: number | null | undefined): string | null =>
    typeof value === "number" ? new Date(value * 1000).toISOString() : null;

  return {
    status: subscription.status as SubscriptionStatus,
    plan: planItem.plan,
    interval: planItem.interval,
    stripeCustomerId:
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id,
    stripeSubscriptionId: subscription.id,
    stripePriceId: planItem.priceId,
    currentPeriodStart: seconds(
      subscription.current_period_start ?? planItem.item.current_period_start
    ),
    currentPeriodEnd: seconds(
      subscription.current_period_end ?? planItem.item.current_period_end
    ),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    trialEnd: seconds(subscription.trial_end),
  };
}

/**
 * Mirrors a Stripe subscription into the workspace. Service role: the
 * webhook has no user. The workspace's plan follows the subscription's, and
 * a trial, once seen, is marked used for good.
 */
export async function syncSubscription(
  admin: SupabaseClient,
  workspaceId: string,
  upsert: SubscriptionUpsert
): Promise<void> {
  const { error } = await admin.from("subscriptions").upsert(
    {
      workspace_id: workspaceId,
      status: upsert.status,
      plan: upsert.plan,
      billing_interval: upsert.interval,
      stripe_customer_id: upsert.stripeCustomerId,
      stripe_subscription_id: upsert.stripeSubscriptionId,
      stripe_price_id: upsert.stripePriceId,
      current_period_start: upsert.currentPeriodStart,
      current_period_end: upsert.currentPeriodEnd,
      cancel_at_period_end: upsert.cancelAtPeriodEnd,
      trial_end: upsert.trialEnd,
      ...(upsert.status === "trialing" || upsert.trialEnd ? { trial_used: true } : {}),
    },
    { onConflict: "workspace_id" }
  );
  if (error) {
    logger.error("billing.sync_failed", { workspaceId, ...errorFields(error) });
    throw new Error("Could not sync subscription");
  }

  const { error: planError } = await admin
    .from("workspaces")
    .update({ plan: upsert.plan, stripe_customer_id: upsert.stripeCustomerId })
    .eq("id", workspaceId);
  if (planError) {
    logger.error("billing.plan_sync_failed", { workspaceId, ...errorFields(planError) });
  }
}

/** Finds the workspace a Stripe customer belongs to. */
export async function workspaceForCustomer(
  admin: SupabaseClient,
  customerId: string
): Promise<string | null> {
  const { data } = await admin
    .from("workspaces")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle<{ id: string }>();
  return data?.id ?? null;
}

function fromRow(row: Row): Subscription {
  return {
    status: row.status,
    plan: row.plan,
    interval: row.billing_interval,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripePriceId: row.stripe_price_id,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    trialEnd: row.trial_end,
    trialUsed: row.trial_used,
  };
}
