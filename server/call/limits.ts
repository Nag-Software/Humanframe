import { logger } from "@/lib/logger";
import {
  decideCallStart,
  type CallKind,
  type PlanId,
  type UsageSettings,
} from "@/lib/plans";
import { loadUsageSettings } from "@/lib/settings/usage-settings";
import { billingEnabled } from "@/server/billing/stripe";
import {
  billingPeriod,
  isEntitled,
  loadSubscription,
  type Subscription,
} from "@/server/billing/subscriptions";
import { loadUsageSummary } from "@/server/billing/usage";
import { callClient } from "@/server/call/binding";

/**
 * What is actually enforced, and where.
 *
 * A browser timer is a courtesy, not a limit: the page can be closed, the
 * script can be edited, and neither stops a call that is already connected.
 * These checks run on the server, before a call is created, and they are the
 * only ones that bound spend:
 *
 *  - CALL_MAX_PER_DAY    calls one user may start in a rolling 24 hours
 *  - CALL_MAX_CONCURRENT calls one workspace may have open at once
 *  - CALL_MAX_MINUTES    how long any call may run before the server ends it
 *  - the plan            included minutes, and whether the workspace has
 *                        agreed to pay beyond them (`lib/plans.ts`)
 *
 * The plan decision yields a per-call ceiling in seconds, stored on the call,
 * so a call inside the last included minutes ends when they run out unless
 * overage is on — and never past the overage cap.
 *
 * The duration limit is enforced by refusing to serve a call that has run past
 * it — the provider bills the media path directly, so the honest statement is
 * that Humanframe caps what it will start and keep serving, not that it can cut
 * an in-flight audio stream off to the second. That is why the daily and
 * concurrency caps exist: they bound the number of streams, which is the part
 * that is actually controllable.
 */
export const CALL_LIMITS = {
  maxPerDay: readNumber("CALL_MAX_PER_DAY", 20),
  maxConcurrent: readNumber("CALL_MAX_CONCURRENT", 1),
  maxMinutes: readNumber("CALL_MAX_MINUTES", 15),
} as const;

function readNumber(variable: string, fallback: number): number {
  const raw = process.env[variable]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type LimitReason =
  | "daily_limit"
  | "concurrent_limit"
  | "no_subscription"
  | "plan_exhausted"
  | "overage_cap";

export type LimitVerdict =
  | { allowed: true; allowedSeconds: number; beyondPlan: boolean }
  | { allowed: false; reason: LimitReason; message: string };

export type LimitMessages = Record<LimitReason, string>;

const DEFAULT_MESSAGES: LimitMessages = {
  daily_limit: "You have used today's calls. Try again tomorrow.",
  concurrent_limit: "You already have a call in progress.",
  no_subscription: "Humanframe needs a plan before Maya can take calls. Choose one in Settings.",
  plan_exhausted:
    "Your plan's minutes for this are used up. Allow usage beyond your plan in Settings to keep going.",
  overage_cap: "You have reached the monthly cap you set for usage beyond your plan.",
};

export async function checkCallLimits(input: {
  workspaceId: string;
  userId: string;
  kind: CallKind;
  plan: PlanId;
  settings?: UsageSettings;
  /** Pass to skip the lookup; `null` means "known to have none". */
  subscription?: Subscription | null;
  /** Whether a subscription is required at all. Defaults to BILLING_ENABLED. */
  requireSubscription?: boolean;
  messages?: Partial<LimitMessages>;
  now?: Date;
}): Promise<LimitVerdict> {
  const client = callClient();
  const messages = { ...DEFAULT_MESSAGES, ...input.messages };
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();

  const subscription =
    input.subscription === undefined
      ? await loadSubscription(client, input.workspaceId)
      : input.subscription;
  const requireSubscription = input.requireSubscription ?? billingEnabled();
  if (requireSubscription && !isEntitled(subscription?.status ?? "none")) {
    return {
      allowed: false,
      reason: "no_subscription",
      message: messages.no_subscription,
    };
  }

  const [{ count: startedToday }, { count: open }, usage, settings] =
    await Promise.all([
      client
        .from("call_sessions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", input.userId)
        .gte("started_at", since),
      client
        .from("call_sessions")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", input.workspaceId)
        .in("status", ["connecting", "active"]),
      loadUsageSummary(client, {
        workspaceId: input.workspaceId,
        plan: input.plan,
        now,
        period: billingPeriod(subscription) ?? undefined,
      }),
      input.settings ?? loadUsageSettings(client, input.workspaceId),
    ]);

  if ((startedToday ?? 0) >= CALL_LIMITS.maxPerDay) {
    logger.warn("call.rate_limited", {
      workspaceId: input.workspaceId,
      startedToday,
    });
    return { allowed: false, reason: "daily_limit", message: messages.daily_limit };
  }

  if ((open ?? 0) >= CALL_LIMITS.maxConcurrent) {
    return {
      allowed: false,
      reason: "concurrent_limit",
      message: messages.concurrent_limit,
    };
  }

  const allowance = decideCallStart({
    kind: input.kind,
    usage,
    settings,
    maxCallSeconds: CALL_LIMITS.maxMinutes * 60,
  });

  if (!allowance.allowed) {
    logger.info("call.plan_refused", {
      workspaceId: input.workspaceId,
      kind: input.kind,
      reason: allowance.reason,
      overageUsd: usage.overageUsd,
    });
    return {
      allowed: false,
      reason: allowance.reason,
      message: messages[allowance.reason],
    };
  }

  return {
    allowed: true,
    allowedSeconds: allowance.allowedSeconds,
    beyondPlan: allowance.beyondPlan,
  };
}

/**
 * True once a call has outlived what the server agreed to serve: the global
 * ceiling, or the tighter one the plan decided at start.
 */
export function hasExpired(
  startedAt: string,
  allowedSeconds: number | null = null
): boolean {
  const age = Date.now() - new Date(startedAt).getTime();
  const ceiling = Math.min(
    CALL_LIMITS.maxMinutes * 60,
    allowedSeconds ?? Number.POSITIVE_INFINITY
  );
  return age > ceiling * 1000;
}

/**
 * Ends this user's own calls that are still open, because they are about to
 * start another one.
 *
 * The concurrency cap bounds how many media streams run at once. It was never
 * meant to lock someone out of a call they have already walked away from, and
 * that is what it did: a browser that reloads, crashes or navigates loses the
 * call id it would have hung up with, so the row stayed open until the stale
 * sweep noticed it `CALL_MAX_MINUTES` later. With the cap at one, the user
 * simply could not call for a quarter of an hour, and restarting the dev
 * server did nothing because the row is in the database.
 *
 * Starting a call is the moment we know the previous one is over: whatever was
 * still connected belonged to a page that no longer exists. The browser
 * already tries to say so before it starts, and cannot after a reload — this
 * is the same intent, made reliable by being server-side.
 *
 * Scoped to the one user. Another person's live call is not ours to hang up,
 * and the cap still holds against them.
 */
export async function endAbandonedCalls(input: {
  workspaceId: string;
  userId: string;
}): Promise<number> {
  const { data, error } = await callClient()
    .from("call_sessions")
    .update({
      status: "ended",
      end_reason: "superseded",
      ended_at: new Date().toISOString(),
    })
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .in("status", ["connecting", "active"])
    .select("id");

  if (error) {
    logger.error("call.supersede_failed", {
      workspaceId: input.workspaceId,
      message: error.message,
    });
    return 0;
  }

  return data?.length ?? 0;
}

/**
 * Closes calls that were never hung up — a closed laptop, a lost network, a
 * crashed tab — so they stop counting against the concurrency cap and stop
 * accruing minutes on the meter.
 *
 * This still matters for calls nobody comes back to: `endAbandonedCalls` only
 * runs when the same user starts another one.
 */
export async function reapStaleCalls(workspaceId: string): Promise<void> {
  const cutoff = new Date(
    Date.now() - CALL_LIMITS.maxMinutes * 60_000
  ).toISOString();

  const { error } = await callClient()
    .from("call_sessions")
    .update({
      status: "ended",
      end_reason: "expired",
      ended_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .in("status", ["connecting", "active"])
    .lt("started_at", cutoff);

  if (error) {
    logger.error("call.reap_failed", { workspaceId, message: error.message });
  }
}
