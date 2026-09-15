import { logger } from "@/lib/logger";
import { callClient } from "@/server/call/binding";

/**
 * What is actually enforced, and where.
 *
 * A browser timer is a courtesy, not a limit: the page can be closed, the
 * script can be edited, and neither stops a call that is already connected.
 * These three checks run on the server, before a call is created, and they are
 * the only ones that bound spend:
 *
 *  - CALL_MAX_PER_DAY   calls one user may start in a rolling 24 hours
 *  - CALL_MAX_CONCURRENT calls one workspace may have open at once
 *  - CALL_MAX_MINUTES   how long a call may run before the server ends it
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

export type LimitVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; message: string };

export async function checkCallLimits(input: {
  workspaceId: string;
  userId: string;
}): Promise<LimitVerdict> {
  const client = callClient();
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

  const [{ count: startedToday }, { count: open }] = await Promise.all([
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
  ]);

  if ((startedToday ?? 0) >= CALL_LIMITS.maxPerDay) {
    logger.warn("call.rate_limited", {
      workspaceId: input.workspaceId,
      startedToday,
    });
    return {
      allowed: false,
      reason: "daily_limit",
      message: "Du har brukt opp dagens samtaler. Prøv igjen i morgen.",
    };
  }

  if ((open ?? 0) >= CALL_LIMITS.maxConcurrent) {
    return {
      allowed: false,
      reason: "concurrent_limit",
      message: "Du har allerede en samtale i gang.",
    };
  }

  return { allowed: true };
}

/** True once a call has outlived the configured ceiling. */
export function hasExpired(startedAt: string): boolean {
  const age = Date.now() - new Date(startedAt).getTime();
  return age > CALL_LIMITS.maxMinutes * 60_000;
}

/**
 * Closes calls that were never hung up — a closed laptop, a lost network, a
 * crashed tab — so they stop counting against the concurrency cap.
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
