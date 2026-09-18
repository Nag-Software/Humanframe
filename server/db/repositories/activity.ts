import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What Maya is doing right now, for the sidebar.
 *
 * Two sources, one list: background tasks that have not finished, and
 * commitments she has woken up for and is still working through. Scheduled
 * commitments are not "now" — they are what she is holding, on her profile.
 * Reads through the user's client, so row level security scopes it.
 */
export type ActivityStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "waking"
  | "in_progress";

export type LiveActivity = {
  id: string;
  kind: "task" | "commitment";
  title: string;
  status: ActivityStatus;
  threadId: string;
  /** When this state was last touched — the list sorts on it. */
  since: string;
};

type TaskRow = {
  id: string;
  title: string;
  status: "queued" | "running" | "waiting_input" | "waiting_approval";
  thread_id: string;
  updated_at: string;
};

type CommitmentRow = {
  id: string;
  title: string;
  status: "waking" | "in_progress" | "waiting_approval";
  thread_id: string;
  updated_at: string;
};

const LIMIT = 10;

export async function listLiveActivity(
  client: SupabaseClient,
  workspaceId: string,
  assistantId: string
): Promise<LiveActivity[]> {
  const [tasks, commitments] = await Promise.all([
    client
      .from("tasks")
      .select("id, title, status, thread_id, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("assistant_id", assistantId)
      .in("status", ["queued", "running", "waiting_input", "waiting_approval"])
      .order("updated_at", { ascending: false })
      .limit(LIMIT)
      .returns<TaskRow[]>(),
    client
      .from("commitments")
      .select("id, title, status, thread_id, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("assistant_id", assistantId)
      .in("status", ["waking", "in_progress", "waiting_approval"])
      .order("updated_at", { ascending: false })
      .limit(LIMIT)
      .returns<CommitmentRow[]>(),
  ]);

  const items: LiveActivity[] = [
    ...(tasks.data ?? []).map((row) => ({
      id: row.id,
      kind: "task" as const,
      title: row.title,
      status: row.status,
      threadId: row.thread_id,
      since: row.updated_at,
    })),
    ...(commitments.data ?? []).map((row) => ({
      id: row.id,
      kind: "commitment" as const,
      title: row.title,
      status: row.status,
      threadId: row.thread_id,
      since: row.updated_at,
    })),
  ];

  return items
    .sort((a, b) => b.since.localeCompare(a.since))
    .slice(0, LIMIT);
}
