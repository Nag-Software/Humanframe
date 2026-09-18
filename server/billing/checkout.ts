import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import type { PlanId } from "@/lib/plans";
import {
  getStripe,
  priceCatalog,
  type BillingInterval,
} from "@/server/billing/stripe";
import { loadSubscription } from "@/server/billing/subscriptions";

/** The $1-a-day trial: three days, paid as one pass, then the plan. */
export const TRIAL_DAYS = 3;

/**
 * The Stripe customer for a workspace, created on first need and remembered
 * on the workspace. Service role, because the customer id is written to a
 * column members cannot write.
 */
export async function ensureCustomer(
  admin: SupabaseClient,
  input: { workspaceId: string; workspaceName: string; email: string | null }
): Promise<string> {
  const { data } = await admin
    .from("workspaces")
    .select("stripe_customer_id")
    .eq("id", input.workspaceId)
    .maybeSingle<{ stripe_customer_id: string | null }>();
  if (data?.stripe_customer_id) {
    return data.stripe_customer_id;
  }

  const customer = await getStripe().customers.create({
    name: input.workspaceName,
    email: input.email ?? undefined,
    metadata: { workspace_id: input.workspaceId },
  });

  const { error } = await admin
    .from("workspaces")
    .update({ stripe_customer_id: customer.id })
    .eq("id", input.workspaceId)
    .is("stripe_customer_id", null);
  if (error) {
    // Someone else won the race; use theirs and let this customer sit unused.
    const { data: theirs } = await admin
      .from("workspaces")
      .select("stripe_customer_id")
      .eq("id", input.workspaceId)
      .single<{ stripe_customer_id: string | null }>();
    return theirs?.stripe_customer_id ?? customer.id;
  }
  return customer.id;
}

/**
 * Checkout for a plan.
 *
 * Every subscription carries three prices: the plan, and the two metered
 * overage prices that the call ledger reports seconds into. A workspace that
 * has never trialed gets the trial: three days before the plan bills, and a
 * one-time pass charged at checkout — the "$1 a day" the site promises.
 */
export async function createCheckoutSession(
  admin: SupabaseClient,
  input: {
    workspaceId: string;
    workspaceName: string;
    email: string | null;
    plan: PlanId;
    interval: BillingInterval;
    origin: string;
  }
): Promise<{ url: string }> {
  const stripe = getStripe();
  const catalog = priceCatalog();
  const [customerId, existing] = await Promise.all([
    ensureCustomer(admin, input),
    loadSubscription(admin, input.workspaceId),
  ]);

  if (
    existing?.stripeSubscriptionId &&
    (existing.status === "active" || existing.status === "trialing" || existing.status === "past_due")
  ) {
    // Changing plan is done in the portal, against the existing subscription,
    // so a workspace never ends up paying for two.
    throw new Error("already_subscribed");
  }

  const trial = !(existing?.trialUsed ?? false);
  const returnTo = `${input.origin}/assistants/maya?settings=billing`;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: input.workspaceId,
    line_items: [
      { price: catalog.plans[input.plan][input.interval], quantity: 1 },
      { price: catalog.overage.voice },
      { price: catalog.overage.video },
      ...(trial ? [{ price: catalog.trialPass, quantity: 1 }] : []),
    ],
    subscription_data: {
      metadata: { workspace_id: input.workspaceId, plan: input.plan },
      ...(trial ? { trial_period_days: TRIAL_DAYS } : {}),
    },
    payment_method_collection: "always",
    allow_promotion_codes: true,
    success_url: `${returnTo}&checkout=success`,
    cancel_url: `${returnTo}&checkout=cancelled`,
    metadata: { workspace_id: input.workspaceId },
  });

  if (!session.url) {
    throw new Error("Stripe returned no checkout url");
  }

  logger.info("billing.checkout_started", {
    workspaceId: input.workspaceId,
    plan: input.plan,
    interval: input.interval,
    trial,
  });
  return { url: session.url };
}

/** The Stripe-hosted portal: change plan, update card, cancel, invoices. */
export async function createPortalSession(input: {
  customerId: string;
  origin: string;
}): Promise<{ url: string }> {
  const session = await getStripe().billingPortal.sessions.create({
    customer: input.customerId,
    return_url: `${input.origin}/assistants/maya?settings=billing`,
  });
  return { url: session.url };
}
