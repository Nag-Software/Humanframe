import type { SupabaseClient } from "@supabase/supabase-js";

import { errorFields, logger } from "@/lib/logger";
import { encodeCursor, type Cursor } from "@/server/db/cursor";

const THREADS = "threads";

export type Channel = "chat" | "live" | "facetime" | "system";

export type ThreadScope = {
  client: SupabaseClient;
  workspaceId: string;
  userId: string;
};

export type Thread = {
  id: string;
  title: string | null;
  channel: Channel;
  status: "active" | "archived";
  assistantId: string;
  eveSessionId: string | null;
  lastMessageAt: string;
};

type ThreadRow = {
  id: string;
  title: string | null;
  channel: Channel;
  status: "active" | "archived";
  assistant_id: string;
  eve_session_id: string | null;
  last_message_at: string;
};

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    channel: row.channel,
    status: row.status,
    assistantId: row.assistant_id,
    eveSessionId: row.eve_session_id,
    lastMessageAt: row.last_message_at,
  };
}

const THREAD_COLUMNS =
  "id, title, channel, status, assistant_id, eve_session_id, last_message_at";

/**
 * Claims a thread id for this workspace. Row level security rejects an id that
 * already belongs to another workspace, which is what makes this safe to call
 * before any model work runs.
 */
export async function ensureThread(
  scope: ThreadScope,
  input: {
    threadId: string;
    assistantId: string;
    title?: string;
    channel?: Channel;
  }
): Promise<void> {
  const { error } = await scope.client.from(THREADS).upsert(
    {
      id: input.threadId,
      workspace_id: scope.workspaceId,
      assistant_id: input.assistantId,
      created_by: scope.userId,
      channel: input.channel ?? "chat",
      title: input.title?.slice(0, 120) ?? null,
    },
    { onConflict: "id", ignoreDuplicates: true }
  );

  if (error) {
    logger.error("db.ensure_thread_failed", {
      threadId: input.threadId,
      ...errorFields(error),
    });
    throw new Error("Could not create thread");
  }
}

/**
 * The canonical thread for an eve session, created on first sight.
 *
 * `threads.eve_session_id` is unique, so this converges on one row no matter
 * how many times it runs or who calls it first. The database mints the id;
 * nothing upstream invents one.
 */
export async function ensureThreadForSession(
  scope: ThreadScope,
  input: {
    eveSessionId: string;
    assistantId: string;
    title?: string;
    channel?: Channel;
  }
): Promise<string> {
  const existing = await findThreadIdBySession(scope, input.eveSessionId);
  if (existing) {
    await linkSession(scope, existing, input.eveSessionId, "initial");
    return existing;
  }

  const { data, error } = await scope.client
    .from(THREADS)
    .insert({
      workspace_id: scope.workspaceId,
      assistant_id: input.assistantId,
      created_by: scope.userId,
      channel: input.channel ?? "chat",
      eve_session_id: input.eveSessionId,
      title: input.title?.slice(0, 120) ?? null,
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (data) {
    await linkSession(scope, data.id, input.eveSessionId, "initial");
    return data.id;
  }

  // Someone else won the race on the unique index.
  const raced = await findThreadIdBySession(scope, input.eveSessionId);
  if (raced) {
    await linkSession(scope, raced, input.eveSessionId, "initial");
    return raced;
  }

  logger.error("db.ensure_thread_for_session_failed", {
    eveSessionId: input.eveSessionId,
    ...errorFields(error),
  });
  throw new Error("Could not create thread");
}

/**
 * Records that a thread owned this eve session.
 *
 * `threads.eve_session_id` is the current session; this is the history, so a
 * conversation can outlive a session without losing its identity. Idempotent on
 * the session id, so replaying a claim adds nothing.
 */
export async function linkSession(
  scope: ThreadScope,
  threadId: string,
  eveSessionId: string,
  reason: "initial" | "wake_recovery"
): Promise<void> {
  const { error } = await scope.client.from("thread_sessions").upsert(
    {
      workspace_id: scope.workspaceId,
      thread_id: threadId,
      eve_session_id: eveSessionId,
      reason,
    },
    { onConflict: "eve_session_id", ignoreDuplicates: true }
  );

  if (error) {
    // The thread is already usable without this row; losing it only costs the
    // ability to resolve an old session later.
    logger.error("db.link_session_failed", {
      threadId,
      eveSessionId,
      ...errorFields(error),
    });
  }
}

export async function findThreadIdBySession(
  scope: ThreadScope,
  eveSessionId: string
): Promise<string | null> {
  const { data } = await scope.client
    .from(THREADS)
    .select("id")
    .eq("eve_session_id", eveSessionId)
    .maybeSingle<{ id: string }>();
  return data?.id ?? null;
}

export async function getThread(
  scope: ThreadScope,
  threadId: string
): Promise<Thread | null> {
  const { data } = await scope.client
    .from(THREADS)
    .select(THREAD_COLUMNS)
    .eq("id", threadId)
    .maybeSingle<ThreadRow>();

  return data ? toThread(data) : null;
}

/** Binds a thread to its durable eve session. */
export async function linkEveSession(
  scope: ThreadScope,
  threadId: string,
  eveSessionId: string
): Promise<void> {
  const { error } = await scope.client
    .from(THREADS)
    .update({ eve_session_id: eveSessionId })
    .eq("id", threadId);

  if (error) {
    logger.error("db.link_eve_session_failed", {
      threadId,
      ...errorFields(error),
    });
  }
}

export async function touchThread(
  scope: ThreadScope,
  threadId: string,
  lastMessageAt: string,
  title?: string
): Promise<void> {
  const patch: Record<string, unknown> = { last_message_at: lastMessageAt };
  if (title) {
    patch.title = title.slice(0, 120);
  }
  await scope.client.from(THREADS).update(patch).eq("id", threadId);
}

/** Keyset pagination on `(last_message_at, id)`; never OFFSET. */
export async function listThreads(
  scope: ThreadScope,
  options: { limit?: number; cursor?: Cursor | null; assistantId?: string } = {}
): Promise<{ threads: Thread[]; nextCursor: string | null }> {
  const limit = Math.min(options.limit ?? 20, 100);

  let query = scope.client
    .from(THREADS)
    .select(THREAD_COLUMNS)
    .eq("status", "active")
    .order("last_message_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (options.assistantId) {
    query = query.eq("assistant_id", options.assistantId);
  }
  if (options.cursor) {
    query = query.or(
      `last_message_at.lt.${options.cursor.createdAt},` +
        `and(last_message_at.eq.${options.cursor.createdAt},id.lt.${options.cursor.id})`
    );
  }

  const { data, error } = await query.returns<ThreadRow[]>();
  if (error || !data) {
    return { threads: [], nextCursor: null };
  }

  const threads = data.map(toThread);
  const last = data.at(-1);
  const nextCursor =
    data.length === limit && last
      ? encodeCursor({ createdAt: last.last_message_at, id: last.id })
      : null;

  return { threads, nextCursor };
}
