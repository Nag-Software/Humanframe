/**
 * Plans, included minutes and overage — the numbers, and the arithmetic.
 *
 * Pure: nothing here reads a database or the clock. The marketing site and
 * the app show the same figures because they come from this file.
 *
 * Overage is priced per minute at about twice what a minute costs to serve
 * (voice ≈ $0.07: gpt-live-1 at $0.05 plus the odd delegation; video ≈ $0.44:
 * Tavus at $0.37 plus the voice). It is counted in money, never in credits —
 * a colleague is not metered in tokens.
 */
export type PlanId = "starter" | "pro";

export type CallKind = "voice" | "video";

export type Plan = {
  id: PlanId;
  monthlyUsd: number;
  /** Per month, when billed yearly (two months free). */
  yearlyMonthlyUsd: number;
  includedMinutes: Record<CallKind, number>;
};

export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: "starter",
    monthlyUsd: 49.9,
    yearlyMonthlyUsd: 41.6,
    includedMinutes: { voice: 180, video: 30 },
  },
  pro: {
    id: "pro",
    monthlyUsd: 124.9,
    yearlyMonthlyUsd: 104.1,
    includedMinutes: { voice: 540, video: 90 },
  },
};

/** USD per minute beyond the plan. */
export const OVERAGE_USD_PER_MINUTE: Record<CallKind, number> = {
  voice: 0.15,
  video: 0.89,
};

export const CALL_KINDS: readonly CallKind[] = ["voice", "video"];

export type KindUsage = {
  kind: CallKind;
  usedSeconds: number;
  includedSeconds: number;
  /** Seconds beyond the plan. */
  overageSeconds: number;
  overageUsd: number;
};

export type UsageSummary = {
  plan: PlanId;
  periodStart: string;
  periodEnd: string;
  voice: KindUsage;
  video: KindUsage;
  /** Total money beyond the plan this period. */
  overageUsd: number;
};

export type UsageSettings = {
  allowOverage: boolean;
  /** A monthly ceiling on overage in USD; null means no ceiling. */
  overageCapUsd: number | null;
};

export const DEFAULT_USAGE_SETTINGS: UsageSettings = {
  allowOverage: false,
  overageCapUsd: null,
};

/** The calendar month, in UTC, that contains `now`. */
export function periodBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/** Overage is billed per started minute, like the providers bill us. */
export function overageUsdFor(kind: CallKind, overageSeconds: number): number {
  const minutes = Math.ceil(Math.max(0, overageSeconds) / 60);
  return round2(minutes * OVERAGE_USD_PER_MINUTE[kind]);
}

export function summarizeUsage(input: {
  plan: PlanId;
  now: Date;
  usedSeconds: Record<CallKind, number>;
  /** The billing period; the calendar month when there is no subscription. */
  period?: { start: Date; end: Date };
}): UsageSummary {
  const plan = PLANS[input.plan];
  const { start, end } = input.period ?? periodBounds(input.now);

  const forKind = (kind: CallKind): KindUsage => {
    const usedSeconds = Math.max(0, Math.round(input.usedSeconds[kind]));
    const includedSeconds = plan.includedMinutes[kind] * 60;
    const overageSeconds = Math.max(0, usedSeconds - includedSeconds);
    return {
      kind,
      usedSeconds,
      includedSeconds,
      overageSeconds,
      overageUsd: overageUsdFor(kind, overageSeconds),
    };
  };

  const voice = forKind("voice");
  const video = forKind("video");
  return {
    plan: input.plan,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    voice,
    video,
    overageUsd: round2(voice.overageUsd + video.overageUsd),
  };
}

export type CallAllowance =
  | { allowed: true; allowedSeconds: number; beyondPlan: boolean }
  | { allowed: false; reason: "plan_exhausted" | "overage_cap" };

/**
 * May this call start, and for how long may the server serve it?
 *
 * Inside the plan: yes, and the call may run until the included minutes are
 * gone — unless overage is allowed, in which case it may keep going. Beyond
 * the plan: only if the workspace said so, and only within its cap. The
 * result is a hard ceiling in seconds, so a call can never run past what the
 * workspace agreed to pay for.
 */
export function decideCallStart(input: {
  kind: CallKind;
  usage: UsageSummary;
  settings: UsageSettings;
  /** The global per-call ceiling, whatever the plan says. */
  maxCallSeconds: number;
}): CallAllowance {
  const kindUsage = input.usage[input.kind];
  const remainingIncluded = Math.max(
    0,
    kindUsage.includedSeconds - kindUsage.usedSeconds
  );
  const rate = OVERAGE_USD_PER_MINUTE[input.kind];

  // How many more seconds the cap would still pay for, across both kinds.
  const capRemainingSeconds = (() => {
    if (!input.settings.allowOverage) return 0;
    if (input.settings.overageCapUsd === null) return Number.POSITIVE_INFINITY;
    const left = input.settings.overageCapUsd - input.usage.overageUsd;
    return left <= 0 ? 0 : Math.floor((left / rate) * 60);
  })();

  if (remainingIncluded > 0) {
    const ceiling = Math.min(
      input.maxCallSeconds,
      remainingIncluded + capRemainingSeconds
    );
    return { allowed: true, allowedSeconds: Math.max(1, ceiling), beyondPlan: false };
  }

  if (!input.settings.allowOverage) {
    return { allowed: false, reason: "plan_exhausted" };
  }
  if (capRemainingSeconds < 60) {
    return { allowed: false, reason: "overage_cap" };
  }
  return {
    allowed: true,
    allowedSeconds: Math.min(input.maxCallSeconds, capRemainingSeconds),
    beyondPlan: true,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
