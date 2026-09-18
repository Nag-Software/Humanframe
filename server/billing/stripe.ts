import Stripe from "stripe";

import { serverEnv } from "@/lib/env";
import type { PlanId } from "@/lib/plans";

/**
 * The one Stripe client, and the catalogue it bills against.
 *
 * Price ids are configuration, not code: `scripts/stripe-setup.mts` creates
 * the products, prices and meters once per Stripe account and prints the
 * variables. Everything that maps a Stripe object back to a plan goes through
 * `planForPrice`, so a price id appears in exactly one place.
 */
export type BillingInterval = "month" | "year";

export type PriceCatalog = {
  plans: Record<PlanId, Record<BillingInterval, string>>;
  overage: { voice: string; video: string };
  trialPass: string;
  meters: { voice: string; video: string };
};

let stripe: Stripe | null = null;

export function billingEnabled(): boolean {
  return serverEnv().BILLING_ENABLED === "true";
}

export function getStripe(): Stripe {
  const env = serverEnv();
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("Billing needs STRIPE_SECRET_KEY");
  }
  stripe ??= new Stripe(env.STRIPE_SECRET_KEY, {
    appInfo: { name: "Humanframe", url: env.APP_URL },
  });
  return stripe;
}

export function priceCatalog(): PriceCatalog {
  const env = serverEnv();
  const need = (value: string | undefined, name: string): string => {
    if (!value) {
      throw new Error(`Billing needs ${name}; run scripts/stripe-setup.mts`);
    }
    return value;
  };
  return {
    plans: {
      starter: {
        month: need(env.STRIPE_PRICE_STARTER_MONTH, "STRIPE_PRICE_STARTER_MONTH"),
        year: need(env.STRIPE_PRICE_STARTER_YEAR, "STRIPE_PRICE_STARTER_YEAR"),
      },
      pro: {
        month: need(env.STRIPE_PRICE_PRO_MONTH, "STRIPE_PRICE_PRO_MONTH"),
        year: need(env.STRIPE_PRICE_PRO_YEAR, "STRIPE_PRICE_PRO_YEAR"),
      },
    },
    overage: {
      voice: need(env.STRIPE_PRICE_OVERAGE_VOICE, "STRIPE_PRICE_OVERAGE_VOICE"),
      video: need(env.STRIPE_PRICE_OVERAGE_VIDEO, "STRIPE_PRICE_OVERAGE_VIDEO"),
    },
    trialPass: need(env.STRIPE_PRICE_TRIAL_PASS, "STRIPE_PRICE_TRIAL_PASS"),
    meters: { voice: env.STRIPE_METER_VOICE, video: env.STRIPE_METER_VIDEO },
  };
}

/** Which plan and interval a Stripe price id stands for, or null. */
export function planForPrice(
  priceId: string,
  catalog: Pick<PriceCatalog, "plans">
): { plan: PlanId; interval: BillingInterval } | null {
  for (const plan of ["starter", "pro"] as const) {
    for (const interval of ["month", "year"] as const) {
      if (catalog.plans[plan][interval] === priceId) {
        return { plan, interval };
      }
    }
  }
  return null;
}
