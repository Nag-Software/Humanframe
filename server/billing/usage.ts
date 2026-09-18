import type { SupabaseClient } from "@supabase/supabase-js";

import {
  periodBounds,
  summarizeUsage,
  type CallKind,
  type PlanId,
  type UsageSummary,
} from "@/lib/plans";

/**
 * What this workspace has used this period, from the call ledger.
 *
 * A call counts from when it started to when it ended — or to now, while it
 * is still running, so a live call already shows on the meter. Calls that
 * failed before connecting cost nothing and are not counted. Works through
 * either client: row level security scopes the user's, the service role
 * passes the workspace explicitly.
 */
type Row = {
  kind: CallKind;
  started_at: string;
  ended_at: string | null;
  status: "connecting" | "active" | "ended" | "failed";
};

export async function loadUsageSummary(
  client: SupabaseClient,
  input: {
    workspaceId: string;
    plan: PlanId;
    now?: Date;
    /** Stripe's period when there is a subscription; the calendar month otherwise. */
    period?: { start: Date; end: Date };
  }
): Promise<UsageSummary> {
  const now = input.now ?? new Date();
  const { start, end } = input.period ?? periodBounds(now);

  const { data } = await client
    .from("call_sessions")
    .select("kind, started_at, ended_at, status")
    .eq("workspace_id", input.workspaceId)
    .in("status", ["connecting", "active", "ended"])
    .gte("started_at", start.toISOString())
    .lt("started_at", end.toISOString())
    .returns<Row[]>();

  const usedSeconds: Record<CallKind, number> = { voice: 0, video: 0 };
  for (const row of data ?? []) {
    const startedAt = new Date(row.started_at).getTime();
    const endedAt = row.ended_at ? new Date(row.ended_at).getTime() : now.getTime();
    const seconds = Math.max(0, (endedAt - startedAt) / 1000);
    usedSeconds[row.kind] += seconds;
  }

  return summarizeUsage({ plan: input.plan, now, usedSeconds, period: { start, end } });
}
