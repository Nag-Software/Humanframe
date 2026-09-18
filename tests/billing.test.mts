// First: it loads .env.local before anything parses the environment.
import { admin, createTestWorkspace, type TestWorkspace } from "./memory-support.mts";
import Stripe from "stripe";

import { summarizeUsage } from "../lib/plans.ts";
import { overageDeltaSeconds } from "../server/billing/overage.ts";
import { planForPrice, type PriceCatalog } from "../server/billing/stripe.ts";
import {
  isEntitled,
  loadSubscription,
  subscriptionFromStripe,
  summarize,
  syncSubscription,
  workspaceForCustomer,
  type StripeSubscriptionLike,
} from "../server/billing/subscriptions.ts";
import { checkCallLimits } from "../server/call/limits.ts";

/**
 * Stripe, without Stripe.
 *
 * The mapping from a Stripe subscription to a workspace, the entitlement
 * rule, the overage delta and the webhook signature check are all pure and
 * run against fixtures. The mirror into the database is real. No network
 * call reaches Stripe.
 *
 *   pnpm test:billing
 */

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const catalog: Pick<PriceCatalog, "plans"> = {
  plans: {
    starter: { month: "price_starter_m", year: "price_starter_y" },
    pro: { month: "price_pro_m", year: "price_pro_y" },
  },
};

const NOW = new Date("2026-09-18T10:00:00Z");
const PERIOD_START = Math.floor(new Date("2026-09-10T00:00:00Z").getTime() / 1000);
const PERIOD_END = Math.floor(new Date("2026-10-10T00:00:00Z").getTime() / 1000);

function stripeSubscription(overrides: Partial<StripeSubscriptionLike> = {}): StripeSubscriptionLike {
  return {
    id: "sub_test",
    status: "active",
    customer: "cus_test",
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      data: [
        { price: { id: "price_overage_voice" } },
        { price: { id: "price_pro_y" }, current_period_start: PERIOD_START, current_period_end: PERIOD_END },
      ],
    },
    metadata: {},
    ...overrides,
  };
}

function pure(): void {
  check("1 a plan price maps to its plan and interval", JSON.stringify(planForPrice("price_pro_y", catalog)) === JSON.stringify({ plan: "pro", interval: "year" }));
  check("2 an unknown price maps to nothing", planForPrice("price_overage_voice", catalog) === null);

  const mapped = subscriptionFromStripe(stripeSubscription(), catalog);
  check("3 the plan item is found among the metered ones", mapped?.plan === "pro" && mapped.interval === "year" && mapped.stripePriceId === "price_pro_y", mapped);
  check("4 the period is read from the item on new API versions", mapped?.currentPeriodStart === "2026-09-10T00:00:00.000Z" && mapped.currentPeriodEnd === "2026-10-10T00:00:00.000Z", mapped);

  const legacy = subscriptionFromStripe(stripeSubscription({ current_period_start: PERIOD_START, current_period_end: PERIOD_END, items: { data: [{ price: { id: "price_starter_m" } }] } }), catalog);
  check("5 …and from the subscription on older ones", legacy?.plan === "starter" && legacy.currentPeriodEnd === "2026-10-10T00:00:00.000Z", legacy);

  const expanded = subscriptionFromStripe(stripeSubscription({ customer: { id: "cus_expanded" }, trial_end: PERIOD_START }), catalog);
  check("6 an expanded customer and a trial end are read", expanded?.stripeCustomerId === "cus_expanded" && expanded.trialEnd === "2026-09-10T00:00:00.000Z", expanded);

  check("7 a subscription with no plan price is refused", subscriptionFromStripe(stripeSubscription({ items: { data: [{ price: { id: "price_overage_voice" } }] } }), catalog) === null);

  check("8 trialing, active and past due are entitled", isEntitled("trialing") && isEntitled("active") && isEntitled("past_due"));
  check("9 canceled, unpaid and none are not", !isEntitled("canceled") && !isEntitled("unpaid") && !isEntitled("none"));

  const summary = summarize(null, "starter", false);
  check("10 no subscription summarises as none with the trial available", summary.status === "none" && summary.trialAvailable && summary.plan === "starter");

  const usage = summarizeUsage({ plan: "starter", now: NOW, usedSeconds: { voice: 180 * 60 + 500, video: 0 } });
  check("11 the first call beyond the plan is reported for all of its overage", overageDeltaSeconds({ kind: "voice", usage, alreadyReportedSeconds: 0 }) === 500);
  check("12 a later call is reported only for what earlier ones were not", overageDeltaSeconds({ kind: "voice", usage, alreadyReportedSeconds: 380 }) === 120);
  check("13 a call inside the plan reports nothing", overageDeltaSeconds({ kind: "video", usage, alreadyReportedSeconds: 0 }) === 0);
}

function signatures(): void {
  const stripe = new Stripe("sk_test_offline");
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const event = stripe.webhooks.constructEvent(payload, header, secret);
  check("14 a signed webhook is accepted", event.id === "evt_1" && event.type === "customer.subscription.updated");

  let rejected = false;
  try {
    stripe.webhooks.constructEvent(payload, header, "whsec_other");
  } catch {
    rejected = true;
  }
  check("15 a wrong secret is rejected", rejected);

  let tampered = false;
  try {
    stripe.webhooks.constructEvent(payload.replace("sub_1", "sub_2"), header, secret);
  } catch {
    tampered = true;
  }
  check("16 a tampered body is rejected", tampered);
}

async function mirror(workspace: TestWorkspace, other: TestWorkspace): Promise<void> {
  const upsert = subscriptionFromStripe(stripeSubscription({ customer: `cus_${workspace.workspaceId.slice(0, 8)}`, status: "trialing", trial_end: PERIOD_START }), catalog)!;
  await syncSubscription(admin, workspace.workspaceId, upsert);

  const stored = await loadSubscription(workspace.userClient, workspace.workspaceId);
  const { data: ws } = await admin.from("workspaces").select("plan, stripe_customer_id").eq("id", workspace.workspaceId).single<{ plan: string; stripe_customer_id: string | null }>();
  check("17 the mirror stores the subscription and moves the workspace to its plan", stored?.status === "trialing" && stored.plan === "pro" && ws?.plan === "pro" && ws.stripe_customer_id === upsert.stripeCustomerId, { stored, ws });
  check("18 a trial, once seen, is used for good", stored?.trialUsed === true);
  check("19 the customer resolves back to the workspace", (await workspaceForCustomer(admin, upsert.stripeCustomerId)) === workspace.workspaceId);

  await syncSubscription(admin, workspace.workspaceId, { ...upsert, status: "active", trialEnd: null, cancelAtPeriodEnd: true });
  const later = await loadSubscription(workspace.userClient, workspace.workspaceId);
  check("20 a later event replaces the earlier state", later?.status === "active" && later.cancelAtPeriodEnd === true && later.trialUsed === true, later);

  const foreign = await loadSubscription(other.userClient, workspace.workspaceId);
  check("21 another workspace cannot read it", foreign === null);

  const { data: inserted } = await admin.from("billing_events").upsert({ id: "evt_once", type: "test" }, { onConflict: "id", ignoreDuplicates: true }).select("id").maybeSingle<{ id: string }>();
  const { data: again } = await admin.from("billing_events").upsert({ id: "evt_once", type: "test" }, { onConflict: "id", ignoreDuplicates: true }).select("id").maybeSingle<{ id: string }>();
  check("22 a Stripe event is recorded once", inserted?.id === "evt_once" && again === null, { inserted, again });
  await admin.from("billing_events").delete().eq("id", "evt_once");
}

async function gate(workspace: TestWorkspace, other: TestWorkspace): Promise<void> {
  const none = await checkCallLimits({ workspaceId: other.workspaceId, userId: other.userId, kind: "voice", plan: "starter", subscription: null, requireSubscription: true, settings: { allowOverage: false, overageCapUsd: null } });
  check("23 without a plan, a call is refused when billing is on", !none.allowed && none.reason === "no_subscription", none);

  const off = await checkCallLimits({ workspaceId: other.workspaceId, userId: other.userId, kind: "voice", plan: "starter", subscription: null, requireSubscription: false, settings: { allowOverage: false, overageCapUsd: null } });
  check("24 …and allowed when billing is off", off.allowed, off);

  const subscribed = await checkCallLimits({ workspaceId: workspace.workspaceId, userId: workspace.userId, kind: "voice", plan: "pro", requireSubscription: true, settings: { allowOverage: false, overageCapUsd: null } });
  check("25 a subscribed workspace passes the gate and gets the Stripe period", subscribed.allowed, subscribed);
}

async function main(): Promise<void> {
  pure();
  signatures();

  const workspace = await createTestWorkspace("billing-a");
  const other = await createTestWorkspace("billing-b");
  try {
    await mirror(workspace, other);
    await gate(workspace, other);
  } finally {
    await workspace.remove();
    await other.remove();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

await main();
