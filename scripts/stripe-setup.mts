/**
 * Creates Humanframe's catalogue in a Stripe account, once, and prints the
 * environment variables the app reads it through.
 *
 *   pnpm stripe:setup
 *
 * The key is read from STRIPE_SECRET_KEY in the environment or, failing
 * that, from .env.local — the same place the app reads it.
 *
 * Idempotent: every price carries a lookup key and every meter an event
 * name, so running it again finds what exists instead of making duplicates.
 * The numbers come from lib/plans.ts, so the site, the app and Stripe agree.
 */
import { existsSync, readFileSync } from "node:fs";

import Stripe from "stripe";

import { OVERAGE_USD_PER_MINUTE, PLANS } from "../lib/plans.ts";

function keyFromEnvFile(path = ".env.local"): string | undefined {
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^STRIPE_SECRET_KEY=(.*)$/.exec(line.trim());
    if (match) return match[1].replace(/^["']|["']$/g, "").trim();
  }
  return undefined;
}

const key = process.env.STRIPE_SECRET_KEY || keyFromEnvFile();
if (!key) {
  console.error("Set STRIPE_SECRET_KEY in .env.local (a test key for a test catalogue).");
  process.exit(1);
}
if (!key.startsWith("sk_")) {
  console.error("STRIPE_SECRET_KEY must be a secret key (sk_test_… or sk_live_…), not a publishable one.");
  process.exit(1);
}
const stripe = new Stripe(key);

const METERS = {
  voice: process.env.STRIPE_METER_VOICE ?? "humanframe_voice_overage_seconds",
  video: process.env.STRIPE_METER_VIDEO ?? "humanframe_video_overage_seconds",
} as const;

async function product(name: string, description: string): Promise<Stripe.Product> {
  const existing = await stripe.products.search({ query: `name:'${name}' AND active:'true'` });
  if (existing.data[0]) return existing.data[0];
  return stripe.products.create({ name, description });
}

async function priceByLookup(lookupKey: string): Promise<Stripe.Price | null> {
  const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  return found.data[0] ?? null;
}

async function recurringPrice(input: {
  product: string;
  lookupKey: string;
  interval: "month" | "year";
  cents: number;
  nickname: string;
}): Promise<Stripe.Price> {
  return (
    (await priceByLookup(input.lookupKey)) ??
    stripe.prices.create({
      product: input.product,
      currency: "usd",
      unit_amount: input.cents,
      recurring: { interval: input.interval },
      lookup_key: input.lookupKey,
      nickname: input.nickname,
    })
  );
}

async function meter(eventName: string, displayName: string): Promise<Stripe.Billing.Meter> {
  const existing = await stripe.billing.meters.list({ status: "active", limit: 100 });
  const found = existing.data.find((m) => m.event_name === eventName);
  if (found) return found;
  return stripe.billing.meters.create({
    display_name: displayName,
    event_name: eventName,
    default_aggregation: { formula: "sum" },
    customer_mapping: { event_payload_key: "stripe_customer_id", type: "by_id" },
    value_settings: { event_payload_key: "value" },
  });
}

async function meteredPrice(input: {
  product: string;
  lookupKey: string;
  meterId: string;
  centsPerMinute: number;
  nickname: string;
}): Promise<Stripe.Price> {
  return (
    (await priceByLookup(input.lookupKey)) ??
    stripe.prices.create({
      product: input.product,
      currency: "usd",
      // Seconds come in; Stripe bills per started minute on the period total.
      unit_amount: input.centsPerMinute,
      transform_quantity: { divide_by: 60, round: "up" },
      recurring: { interval: "month", usage_type: "metered", meter: input.meterId },
      lookup_key: input.lookupKey,
      nickname: input.nickname,
    })
  );
}

const cents = (usd: number) => Math.round(usd * 100);

const starter = await product("Humanframe Starter", "Maya on every channel, with time to talk.");
const pro = await product("Humanframe Pro", "Three times the time with Maya.");
const overage = await product("Humanframe minutes beyond your plan", "Calls and FaceTime beyond the plan's included minutes.");
const trial = await product("Humanframe 3-day trial", "Three days with Maya for $1 a day.");

const starterMonth = await recurringPrice({ product: starter.id, lookupKey: "humanframe_starter_month", interval: "month", cents: cents(PLANS.starter.monthlyUsd), nickname: "Starter monthly" });
const starterYear = await recurringPrice({ product: starter.id, lookupKey: "humanframe_starter_year", interval: "year", cents: cents(PLANS.starter.yearlyMonthlyUsd * 12), nickname: "Starter yearly" });
const proMonth = await recurringPrice({ product: pro.id, lookupKey: "humanframe_pro_month", interval: "month", cents: cents(PLANS.pro.monthlyUsd), nickname: "Pro monthly" });
const proYear = await recurringPrice({ product: pro.id, lookupKey: "humanframe_pro_year", interval: "year", cents: cents(PLANS.pro.yearlyMonthlyUsd * 12), nickname: "Pro yearly" });

const voiceMeter = await meter(METERS.voice, "Call seconds beyond plan");
const videoMeter = await meter(METERS.video, "FaceTime seconds beyond plan");
const voiceOverage = await meteredPrice({ product: overage.id, lookupKey: "humanframe_overage_voice", meterId: voiceMeter.id, centsPerMinute: cents(OVERAGE_USD_PER_MINUTE.voice), nickname: "Calls beyond plan" });
const videoOverage = await meteredPrice({ product: overage.id, lookupKey: "humanframe_overage_video", meterId: videoMeter.id, centsPerMinute: cents(OVERAGE_USD_PER_MINUTE.video), nickname: "FaceTime beyond plan" });

const trialPass =
  (await priceByLookup("humanframe_trial_pass")) ??
  (await stripe.prices.create({
    product: trial.id,
    currency: "usd",
    unit_amount: 300,
    lookup_key: "humanframe_trial_pass",
    nickname: "3-day trial pass",
  }));

console.log(`
# Stripe catalogue — paste into .env.local (and Vercel), then set BILLING_ENABLED=true
STRIPE_PRICE_STARTER_MONTH=${starterMonth.id}
STRIPE_PRICE_STARTER_YEAR=${starterYear.id}
STRIPE_PRICE_PRO_MONTH=${proMonth.id}
STRIPE_PRICE_PRO_YEAR=${proYear.id}
STRIPE_PRICE_OVERAGE_VOICE=${voiceOverage.id}
STRIPE_PRICE_OVERAGE_VIDEO=${videoOverage.id}
STRIPE_PRICE_TRIAL_PASS=${trialPass.id}
STRIPE_METER_VOICE=${METERS.voice}
STRIPE_METER_VIDEO=${METERS.video}

# Then add a webhook endpoint in Stripe → Developers → Webhooks:
#   URL:    https://<your-domain>/api/billing/webhook
#   Events: checkout.session.completed, customer.subscription.*, invoice.payment_failed
# and set STRIPE_WEBHOOK_SECRET to its signing secret.
`);
