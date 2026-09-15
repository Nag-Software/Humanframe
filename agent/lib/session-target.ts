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
 * The app owns thread creation: `/api/assistants/maya/session` creates the eve
 * session and claims its thread. This hook only looks the thread up, so it can
 * never race the app into a second, competing row. The lookup retries briefly
 * because the first turn starts streaming while that claim is still in flight.
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

  const threadId = await findThread(client, input.sessionId);
  if (!threadId) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "persist.thread_not_found",
        sessionId: input.sessionId,
      })
    );
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

const LOOKUP_ATTEMPTS = 6;
const LOOKUP_DELAY_MS = 250;

async function findThread(
  client: SupabaseClient,
  sessionId: string
): Promise<string | null> {
  for (let attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt += 1) {
    const { data } = await client
      .from("threads")
      .select("id")
      .eq("eve_session_id", sessionId)
      .maybeSingle<{ id: string }>();

    if (data) {
      return data.id;
    }

    // A thread outlives its eve session: when a wake had to create a new one,
    // `threads.eve_session_id` names the current session and thread_sessions
    // holds every session the conversation has ever had. Resolving through it
    // is what keeps a recovered session projecting into the same thread
    // instead of opening a second conversation.
    const { data: linked } = await client
      .from("thread_sessions")
      .select("thread_id")
      .eq("eve_session_id", sessionId)
      .maybeSingle<{ thread_id: string }>();

    if (linked) {
      return linked.thread_id;
    }

    await new Promise((resolve) => setTimeout(resolve, LOOKUP_DELAY_MS));
  }

  return null;
}
