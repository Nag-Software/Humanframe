import type Stripe from "stripe";

import { serverEnv } from "@/lib/env";
import { errorFields, logger } from "@/lib/logger";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { billingEnabled, getStripe, priceCatalog } from "@/server/billing/stripe";
import {
  subscriptionFromStripe,
  syncSubscription,
  workspaceForCustomer,
  type StripeSubscriptionLike,
} from "@/server/billing/subscriptions";

/**
 * Stripe → Humanframe.
 *
 * The signature proves the event came from Stripe; the `billing_events`
 * table proves we have not handled it before. Everything we keep is derived
 * from the subscription object itself, fetched fresh, so an out-of-order
 * event cannot leave the mirror behind reality.
 */
export async function POST(req: Request) {
  if (!billingEnabled()) {
    return Response.json({ error: "Billing is not enabled" }, { status: 404 });
  }
  const env = serverEnv();
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return Response.json({ error: "Webhook is not configured" }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      await req.text(),
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    logger.warn("billing.webhook_rejected", errorFields(error));
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  const admin = getServiceRoleClient();

  // Once per event. A duplicate delivery is acknowledged and ignored.
  const { data: fresh } = await admin
    .from("billing_events")
    .upsert(
      { id: event.id, type: event.type },
      { onConflict: "id", ignoreDuplicates: true }
    )
    .select("id")
    .maybeSingle<{ id: string }>();
  if (!fresh) {
    return Response.json({ received: true, duplicate: true });
  }

  try {
    const workspaceId = await handle(admin, event);
    await admin
      .from("billing_events")
      .update({ processed_at: new Date().toISOString(), workspace_id: workspaceId })
      .eq("id", event.id);
    return Response.json({ received: true });
  } catch (error) {
    await admin
      .from("billing_events")
      .update({ error: error instanceof Error ? error.message : String(error) })
      .eq("id", event.id);
    logger.error("billing.webhook_failed", {
      eventId: event.id,
      type: event.type,
      ...errorFields(error),
    });
    // Stripe retries on 5xx; the row above is what keeps the retry from
    // being treated as a duplicate — it is cleared for another attempt.
    await admin.from("billing_events").delete().eq("id", event.id);
    return Response.json({ error: "Handler failed" }, { status: 500 });
  }
}

async function handle(
  admin: ReturnType<typeof getServiceRoleClient>,
  event: Stripe.Event
): Promise<string | null> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
      if (!subscriptionId) {
        return null;
      }
      const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
      return mirror(admin, subscription as unknown as StripeSubscriptionLike);
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.trial_will_end":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return mirror(admin, event.data.object as unknown as StripeSubscriptionLike);

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      logger.warn("billing.payment_failed", {
        customer: typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id,
        invoice: invoice.id,
      });
      return null;
    }

    default:
      return null;
  }
}

/** Writes the subscription into the workspace it belongs to. */
async function mirror(
  admin: ReturnType<typeof getServiceRoleClient>,
  subscription: StripeSubscriptionLike
): Promise<string | null> {
  const upsert = subscriptionFromStripe(subscription, priceCatalog());
  if (!upsert) {
    logger.warn("billing.subscription_without_plan", { subscriptionId: subscription.id });
    return null;
  }

  const workspaceId =
    subscription.metadata?.workspace_id ??
    (await workspaceForCustomer(admin, upsert.stripeCustomerId));
  if (!workspaceId) {
    throw new Error(`No workspace for customer ${upsert.stripeCustomerId}`);
  }

  await syncSubscription(admin, workspaceId, upsert);
  logger.info("billing.subscription_synced", {
    workspaceId,
    status: upsert.status,
    plan: upsert.plan,
    interval: upsert.interval,
  });
  return workspaceId;
}
