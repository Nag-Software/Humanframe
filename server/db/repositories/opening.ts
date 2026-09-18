import type { SupabaseClient } from "@supabase/supabase-js";

import {
  OPENING_LOOKAHEAD_DAYS,
  OPENING_LOOKBACK_DAYS,
  type OpeningBrief,
} from "@/agent/lib/opening";

const DAY_MS = 24 * 60 * 60_000;

/**
 * What Maya would open the day with, read through the user's own client.
 * Nothing here decides anything; `hasSomethingToOpen` does.
 */
export async function loadOpeningBrief(
  client: SupabaseClient,
  input: {
    workspaceId: string;
    assistantId: string;
    userId: string;
    now?: Date;
  }
): Promise<OpeningBrief> {
  const now = input.now ?? new Date();
  const lookback = new Date(now.getTime() - OPENING_LOOKBACK_DAYS * DAY_MS);
  const lookahead = new Date(now.getTime() + OPENING_LOOKAHEAD_DAYS * DAY_MS);

  const [commitments, threads, membership] = await Promise.all([
    client
      .from("commitments")
      .select("title, kind, due_at, status")
      .eq("workspace_id", input.workspaceId)
      .eq("assistant_id", input.assistantId)
      .in("status", ["scheduled", "waking", "delivered", "in_progress", "waiting_approval"])
      .lte("due_at", lookahead.toISOString())
      .order("due_at", { ascending: true })
      .limit(6)
      .returns<
        { title: string; kind: "follow_up" | "remind" | "deliver"; due_at: string; status: string }[]
      >(),
    client
      .from("threads")
      .select("title, last_message_at")
      .eq("workspace_id", input.workspaceId)
      .eq("assistant_id", input.assistantId)
      .eq("status", "active")
      .gte("last_message_at", lookback.toISOString())
      .order("last_message_at", { ascending: false })
      .limit(5)
      .returns<{ title: string | null; last_message_at: string }[]>(),
    client
      .from("workspace_members")
      .select("timezone")
      .eq("workspace_id", input.workspaceId)
      .eq("user_id", input.userId)
      .maybeSingle<{ timezone: string | null }>(),
  ]);

  return {
    commitments: (commitments.data ?? []).map((row) => ({
      title: row.title,
      kind: row.kind,
      dueAt: row.due_at,
      status: row.status,
    })),
    recentThreads: (threads.data ?? [])
      .filter((row) => row.title)
      .map((row) => ({ title: row.title, lastMessageAt: row.last_message_at })),
    timezone: membership.data?.timezone ?? null,
  };
}
