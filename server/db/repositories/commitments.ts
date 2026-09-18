import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Read-side view of commitments for the shell: what Maya is holding for the
 * user. Writes stay in `agent/lib/commitments.ts`, where the claim and lease
 * discipline lives; nothing here changes a row.
 */
export type CommitmentKind = "follow_up" | "remind" | "deliver";

export type UpcomingCommitment = {
  id: string;
  title: string;
  kind: CommitmentKind;
  dueAt: string;
  status: string;
};

type Row = {
  id: string;
  title: string;
  kind: CommitmentKind;
  due_at: string;
  status: string;
};

/** Everything not yet closed, soonest first. */
const OPEN_STATUSES = [
  "scheduled",
  "waking",
  "delivered",
  "in_progress",
  "waiting_approval",
];

export async function listUpcomingCommitments(
  client: SupabaseClient,
  workspaceId: string,
  assistantId: string,
  limit = 8
): Promise<UpcomingCommitment[]> {
  const { data } = await client
    .from("commitments")
    .select("id, title, kind, due_at, status")
    .eq("workspace_id", workspaceId)
    .eq("assistant_id", assistantId)
    .in("status", OPEN_STATUSES)
    .order("due_at", { ascending: true })
    .limit(limit)
    .returns<Row[]>();

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    dueAt: row.due_at,
    status: row.status,
  }));
}

/** The one thing she will come back to first — the presence bar's state line. */
export async function nextCommitment(
  client: SupabaseClient,
  workspaceId: string,
  assistantId: string
): Promise<UpcomingCommitment | null> {
  const [first] = await listUpcomingCommitments(
    client,
    workspaceId,
    assistantId,
    1
  );
  return first ?? null;
}
