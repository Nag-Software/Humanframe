import type { SupabaseClient } from "@supabase/supabase-js";

import { errorFields, logger } from "@/lib/logger";
import type { MayaMessage } from "@/lib/maya/tools";
import { encodeCursor, type Cursor } from "@/server/db/cursor";
import type { Channel } from "@/server/db/repositories/threads";

const MESSAGES = "messages";

export type MessageScope = {
  client: SupabaseClient;
  workspaceId: string;
  userId: string;
};

export type StoredMessage = {
  id: string;
  role: MayaMessage["role"];
  content: MayaMessage["parts"];
  metadata: MayaMessage["metadata"];
  sourceMessageId: string | null;
  createdAt: string;
};

type MessageRow = {
  id: string;
  role: MayaMessage["role"];
  content: MayaMessage["parts"];
  metadata: MayaMessage["metadata"];
  source_message_id: string | null;
  created_at: string;
};

const MESSAGE_COLUMNS =
  "id, role, content, metadata, source_message_id, created_at";

/**
 * Newest-first keyset pagination on `(created_at, id)`, matching
 * `messages_thread_cursor_idx`. Returned messages are ordered oldest-first for
 * rendering; `nextCursor` walks further back in history.
 */
export async function listMessages(
  scope: MessageScope,
  options: { threadId: string; limit?: number; cursor?: Cursor | null }
): Promise<{ messages: StoredMessage[]; nextCursor: string | null }> {
  const limit = Math.min(options.limit ?? 50, 200);

  let query = scope.client
    .from(MESSAGES)
    .select(MESSAGE_COLUMNS)
    .eq("thread_id", options.threadId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (options.cursor) {
    query = query.or(
      `created_at.lt.${options.cursor.createdAt},` +
        `and(created_at.eq.${options.cursor.createdAt},id.lt.${options.cursor.id})`
    );
  }

  const { data, error } = await query.returns<MessageRow[]>();
  if (error || !data) {
    if (error) {
      logger.error("db.list_messages_failed", {
        threadId: options.threadId,
        ...errorFields(error),
      });
    }
    return { messages: [], nextCursor: null };
  }

  const oldest = data.at(-1);
  const nextCursor =
    data.length === limit && oldest
      ? encodeCursor({ createdAt: oldest.created_at, id: oldest.id })
      : null;

  const messages = data
    .map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      metadata: row.metadata,
      sourceMessageId: row.source_message_id,
      createdAt: row.created_at,
    }))
    .reverse();

  return { messages, nextCursor };
}

export function toUiMessages(messages: StoredMessage[]): MayaMessage[] {
  return messages.map((message) => ({
    id: message.sourceMessageId ?? message.id,
    role: message.role,
    parts: message.content,
    metadata: message.metadata,
  }));
}

export type MessageWrite = {
  threadId: string;
  assistantId: string;
  channel?: Channel;
  role: MayaMessage["role"];
  content: MayaMessage["parts"];
  metadata?: MayaMessage["metadata"];
  /** The producing system's own id: an AI SDK message id, or eve's message id. */
  sourceMessageId?: string;
  /**
   * Must be the event's own timestamp when it comes from eve (`meta.at`), so a
   * replayed hook lands on the same row instead of inserting a duplicate.
   */
  createdAt: string;
  eveSessionId?: string;
  eveTurnId?: string;
};

/**
 * Idempotent on `(thread_id, source_message_id, created_at)`. Callers that own
 * a stable timestamp per message — every eve hook does — can retry freely.
 */
export async function writeMessages(
  scope: MessageScope,
  writes: MessageWrite[]
): Promise<void> {
  if (writes.length === 0) {
    return;
  }

  const rows = writes.map((write) => ({
    workspace_id: scope.workspaceId,
    thread_id: write.threadId,
    assistant_id: write.assistantId,
    channel: write.channel ?? "chat",
    role: write.role,
    content: write.content,
    metadata: write.metadata ?? {},
    source_message_id: write.sourceMessageId ?? null,
    created_at: write.createdAt,
    eve_session_id: write.eveSessionId ?? null,
    eve_turn_id: write.eveTurnId ?? null,
  }));

  const { error } = await scope.client
    .from(MESSAGES)
    .upsert(rows, {
      onConflict: "thread_id,source_message_id,created_at",
      ignoreDuplicates: true,
    });

  if (error) {
    logger.error("db.write_messages_failed", {
      threadId: writes[0]?.threadId,
      ...errorFields(error),
    });
    throw new Error("Could not store messages");
  }
}

/**
 * Timestamps already assigned to this thread's messages, keyed by the
 * producing system's id.
 *
 * The AI SDK chat route re-sends the whole transcript on every turn and has no
 * stable per-message timestamp of its own, so it reuses the ones already
 * stored and only mints new ones for new messages. eve hooks do not need this:
 * they carry `meta.at`.
 */
export async function getSourceTimestamps(
  scope: MessageScope,
  threadId: string
): Promise<Map<string, string>> {
  const { data } = await scope.client
    .from(MESSAGES)
    .select("source_message_id, created_at")
    .eq("thread_id", threadId)
    .not("source_message_id", "is", null)
    .returns<{ source_message_id: string; created_at: string }[]>();

  return new Map(
    (data ?? []).map((row) => [row.source_message_id, row.created_at])
  );
}
