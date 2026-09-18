import type { SupabaseClient } from "@supabase/supabase-js";

import { errorFields, logger } from "@/lib/logger";
import { periodBounds, type CallKind, type PlanId, type UsageSummary } from "@/lib/plans";
import { getStripe, priceCatalog } from "@/server/billing/stripe";
import { billingPeriod, loadSubscription } from "@/server/billing/subscriptions";
import { loadUsageSummary } from "@/server/billing/usage";
import type { CallBinding } from "@/server/call/binding";

/**
 * Reporting what a call cost beyond the plan.
 *
 * Stripe's meter is additive: every event adds seconds, and the metered price
 * turns the period's total into started minutes. So each call must be
 * reported exactly once, for exactly the seconds of it that fell beyond the
 * plan. That number is the difference between the period's overage after the
 * call and what earlier calls were already reported for — computed here,
 * written to the call row, and sent with the call id as the idempotency key.
 */

/** Pure: the seconds of this call that fall beyond the plan. */
export function overageDeltaSeconds(input: {
  kind: CallKind;
  usage: UsageSummary;
  alreadyReportedSeconds: number;
}): number {
  const total = input.usage[input.kind].overageSeconds;
  return Math.max(0, Math.round(total - input.alreadyReportedSeconds));
}

export async function reportCallOverage(
  admin: SupabaseClient,
  input: { binding: CallBinding; plan: PlanId; now?: Date }
): Promise<"reported" | "none" | "already" | "failed"> {
  const { binding } = input;
  const now = input.now ?? new Date();

  try {
    const subscription = await loadSubscription(admin, binding.workspaceId);
    const period = billingPeriod(subscription) ?? periodBounds(now);

    const [usage, reported] = await Promise.all([
      loadUsageSummary(admin, {
        workspaceId: binding.workspaceId,
        plan: input.plan,
        now,
        period,
      }),
      admin
        .from("call_sessions")
        .select("overage_seconds")
        .eq("workspace_id", binding.workspaceId)
        .eq("kind", binding.kind)
        .neq("id", binding.callSessionId)
        .gt("overage_seconds", 0)
        .gte("started_at", period.start.toISOString())
        .lt("started_at", period.end.toISOString())
        .returns<{ overage_seconds: number }[]>(),
    ]);

    const alreadyReportedSeconds = (reported.data ?? []).reduce(
      (sum, row) => sum + row.overage_seconds,
      0
    );
    const delta = overageDeltaSeconds({
      kind: binding.kind,
      usage,
      alreadyReportedSeconds,
    });

    // Claim the report for this call. A row that already carries a report
    // stays as it is, so a retry after a crash cannot double bill.
    const { data: claimed } = await admin
      .from("call_sessions")
      .update({ overage_seconds: delta, overage_reported_at: now.toISOString() })
      .eq("id", binding.callSessionId)
      .is("overage_reported_at", null)
      .select("id")
      .maybeSingle<{ id: string }>();

    if (!claimed) {
      return "already";
    }
    if (delta === 0) {
      return "none";
    }

    const customerId = subscription?.stripeCustomerId ?? null;
    if (!customerId) {
      logger.warn("billing.overage_without_customer", {
        workspaceId: binding.workspaceId,
        callSessionId: binding.callSessionId,
        delta,
      });
      return "failed";
    }

    const catalog = priceCatalog();
    await getStripe().billing.meterEvents.create({
      event_name: catalog.meters[binding.kind],
      identifier: `call:${binding.callSessionId}`,
      timestamp: Math.floor(now.getTime() / 1000),
      payload: { stripe_customer_id: customerId, value: String(delta) },
    });

    logger.info("billing.overage_reported", {
      workspaceId: binding.workspaceId,
      callSessionId: binding.callSessionId,
      kind: binding.kind,
      seconds: delta,
    });
    return "reported";
  } catch (error) {
    logger.error("billing.overage_report_failed", {
      callSessionId: binding.callSessionId,
      ...errorFields(error),
    });
    return "failed";
  }
}
