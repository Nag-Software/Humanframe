import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Goals: standing intentions, with no deadline.
 *
 * A commitment is a date; a goal is a direction. "Hire two engineers before
 * the board meeting" is a goal, and the job posts, the interviews and the
 * follow-ups are commitments that serve it. Maya keeps both, so she can ask
 * whether a promise still serves the purpose it was made for.
 */
export type GoalStatus = "active" | "paused" | "achieved" | "dropped";

export type Goal = {
  id: string;
  workspace_id: string;
  assistant_id: string;
  user_id: string | null;
  title: string;
  detail: string | null;
  status: GoalStatus;
  priority: number;
  target_date: string | null;
  source_thread_id: string | null;
  dedupe_key: string;
  created_at: string;
  updated_at: string;
};

export type GoalScope = {
  client: SupabaseClient;
  workspaceId: string;
  assistantId: string;
};

const GOAL_COLUMNS =
  "id, workspace_id, assistant_id, user_id, title, detail, status, priority, target_date, source_thread_id, dedupe_key, created_at, updated_at";

export const PRIORITY = { low: 0.3, normal: 0.5, high: 0.8 } as const;
export type PriorityLabel = keyof typeof PRIORITY;

export function priorityLabel(value: number): PriorityLabel {
  if (value >= 0.7) return "high";
  if (value <= 0.35) return "low";
  return "normal";
}

/** Replay-stable on `dedupeKey`: a retried tool step claims one row. */
export async function createGoal(
  scope: GoalScope,
  input: {
    title: string;
    detail?: string | null;
    priority?: PriorityLabel;
    targetDate?: string | null;
    userId?: string | null;
    sourceThreadId?: string | null;
    dedupeKey: string;
  }
): Promise<Goal> {
  const { data, error } = await scope.client
    .from("goals")
    .upsert(
      {
        workspace_id: scope.workspaceId,
        assistant_id: scope.assistantId,
        user_id: input.userId ?? null,
        title: input.title,
        detail: input.detail ?? null,
        priority: PRIORITY[input.priority ?? "normal"],
        target_date: input.targetDate ?? null,
        source_thread_id: input.sourceThreadId ?? null,
        dedupe_key: input.dedupeKey,
      },
      { onConflict: "workspace_id,assistant_id,dedupe_key" }
    )
    .select(GOAL_COLUMNS)
    .single<Goal>();

  if (error || !data) {
    throw new Error(`createGoal failed: ${error?.message ?? "no row"}`);
  }
  return data;
}

export async function listGoals(
  scope: GoalScope,
  options: { includeClosed?: boolean; limit?: number } = {}
): Promise<Goal[]> {
  let query = scope.client
    .from("goals")
    .select(GOAL_COLUMNS)
    .eq("workspace_id", scope.workspaceId)
    .eq("assistant_id", scope.assistantId)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(options.limit ?? 50);

  if (!options.includeClosed) {
    query = query.in("status", ["active", "paused"]);
  }

  const { data } = await query.returns<Goal[]>();
  return data ?? [];
}

export async function setGoalStatus(
  scope: GoalScope,
  goalId: string,
  status: GoalStatus
): Promise<Goal | null> {
  const { data } = await scope.client
    .from("goals")
    .update({ status })
    .eq("id", goalId)
    .eq("workspace_id", scope.workspaceId)
    .eq("assistant_id", scope.assistantId)
    .select(GOAL_COLUMNS)
    .maybeSingle<Goal>();
  return data;
}
