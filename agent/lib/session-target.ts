import type { SupabaseClient } from "@supabase/supabase-js";

import { getRuntimeSupabase } from "./supabase";

export type SessionTarget = {
  client: SupabaseClient;
  workspaceId: string;
  assistantId: string;
  threadId: string;
  userId: string;
};

const cache = new Map<string, SessionTarget>();

/**
 * Maps an eve session to the Humanframe rows it belongs to.
 *
 * The thread is keyed on `eve_session_id`, which is unique, so the hook and
 * the app's own link route converge on one row no matter which one gets there
 * first.
 */
export async function resolveSessionTarget(input: {
  sessionId: string;
  userId: string | undefined;
}): Promise<SessionTarget | null> {
  if (!input.userId) {
    // No Supabase principal: a local dev or system session. Nothing to persist.
    return null;
  }

  const cached = cache.get(input.sessionId);
  if (cached) {
    return cached;
  }

  const client = getRuntimeSupabase();
  if (!client) {
    return null;
  }

  const { data: membership } = await client
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", input.userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ workspace_id: string }>();

  if (!membership) {
    return null;
  }

  const { data: assistant } = await client
    .from("assistants")
    .select("id")
    .eq("workspace_id", membership.workspace_id)
    .eq("slug", "maya")
    .maybeSingle<{ id: string }>();

  if (!assistant) {
    return null;
  }

  const threadId = await ensureThread(client, {
    workspaceId: membership.workspace_id,
    assistantId: assistant.id,
    userId: input.userId,
    sessionId: input.sessionId,
  });

  if (!threadId) {
    return null;
  }

  const target: SessionTarget = {
    client,
    workspaceId: membership.workspace_id,
    assistantId: assistant.id,
    threadId,
    userId: input.userId,
  };
  cache.set(input.sessionId, target);
  return target;
}

async function ensureThread(
  client: SupabaseClient,
  input: {
    workspaceId: string;
    assistantId: string;
    userId: string;
    sessionId: string;
  }
): Promise<string | null> {
  const existing = await client
    .from("threads")
    .select("id")
    .eq("eve_session_id", input.sessionId)
    .maybeSingle<{ id: string }>();

  if (existing.data) {
    return existing.data.id;
  }

  const inserted = await client
    .from("threads")
    .insert({
      workspace_id: input.workspaceId,
      assistant_id: input.assistantId,
      created_by: input.userId,
      channel: "chat",
      eve_session_id: input.sessionId,
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (inserted.data) {
    return inserted.data.id;
  }

  // Someone else won the race on the unique eve_session_id index.
  const retry = await client
    .from("threads")
    .select("id")
    .eq("eve_session_id", input.sessionId)
    .maybeSingle<{ id: string }>();

  return retry.data?.id ?? null;
}
