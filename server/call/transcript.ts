import {
  learnFromExchange,
  MIN_USER_CHARACTERS,
} from "@/agent/lib/memory-extraction";
import { logger } from "@/lib/logger";
import type { CallBinding } from "@/server/call/binding";

/**
 * A finished spoken turn, normalised.
 *
 * Providers disagree about almost everything else; they agree that a turn has
 * a stable id, a speaker, some words, and an end. That is all this is, and it
 * is all the persistence path is allowed to know — which is what lets Tavus
 * reuse it in phase 6 without a line of OpenAI code.
 *
 * `interrupted` means the model produced these words but the user cut it off
 * before hearing them all. They are recorded, because the conversation did
 * partly happen, and they are never treated as delivered.
 */
export type CallTurn = {
  /** Stable for the life of the turn. Namespaced by the call when stored. */
  sourceId: string;
  role: "user" | "assistant";
  text: string;
  interrupted?: boolean;
};

export type RecordedTurn = {
  turnId: string;
  messageId: string | null;
  created: boolean;
};

/**
 * Persists one turn into the call's own Humanframe thread.
 *
 * Idempotent on `(call, sourceId)`: the database keeps the timestamp of the
 * first sighting and writes the message with it, so a repeated data channel
 * event, a reconnect, or the flush at hang-up all land on the same row. That is
 * why hang-up is not the only persistence point and does not need to be — every
 * turn is written the moment the provider declares it finished.
 */
export async function recordCallTurn(
  binding: CallBinding,
  turn: CallTurn
): Promise<RecordedTurn | null> {
  const { data, error } = await binding.client.rpc("record_call_turn", {
    p_workspace_id: binding.workspaceId,
    p_call_session_id: binding.callSessionId,
    p_source_id: turn.sourceId,
    p_role: turn.role,
    p_text: turn.text,
    p_status: turn.interrupted ? "interrupted" : "completed",
  });

  if (error) {
    logger.error("call.record_turn_failed", {
      callSessionId: binding.callSessionId,
      sourceId: turn.sourceId,
      message: error.message,
    });
    return null;
  }

  const row = (data as
    | { turn_id: string; message_id: string | null; created: boolean }[]
    | null)?.[0];

  return row
    ? { turnId: row.turn_id, messageId: row.message_id, created: row.created }
    : null;
}

/**
 * Learns from a finished exchange, exactly once.
 *
 * It runs only when persisting the assistant's reply actually created a row, so
 * a replayed turn extracts nothing a second time — the same guard the chat hook
 * gets from eve's turn lifecycle, expressed here as "this write was the first
 * one". An interrupted answer is not learned from: the user never heard it.
 */
export async function learnFromCallExchange(
  binding: CallBinding,
  exchange: { userText: string; assistantText: string; messageId: string | null }
): Promise<void> {
  if (exchange.userText.trim().length < MIN_USER_CHARACTERS) {
    return;
  }

  try {
    const result = await learnFromExchange({
      userText: exchange.userText,
      assistantText: exchange.assistantText,
      scope: {
        client: binding.client,
        workspaceId: binding.workspaceId,
        assistantId: binding.assistantId,
        userId: binding.userId,
      },
      source: {
        threadId: binding.threadId,
        messageId: exchange.messageId,
        occurredAt: new Date().toISOString(),
      },
    });

    if (result) {
      logger.info("call.memory_extracted", {
        callSessionId: binding.callSessionId,
        ...result,
      });
    }
  } catch (error) {
    // Losing a memory must never break a call.
    logger.error("call.memory_extraction_failed", {
      callSessionId: binding.callSessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The user turn a given assistant reply answered, for extraction. */
export async function previousUserTurn(
  binding: CallBinding,
  beforeTurnId: string
): Promise<string | null> {
  const { data: current } = await binding.client
    .from("call_turns")
    .select("first_seen_at")
    .eq("id", beforeTurnId)
    .maybeSingle<{ first_seen_at: string }>();

  if (!current) {
    return null;
  }

  const { data } = await binding.client
    .from("call_turns")
    .select("text")
    .eq("call_session_id", binding.callSessionId)
    .eq("role", "user")
    .lt("first_seen_at", current.first_seen_at)
    .order("first_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ text: string }>();

  return data?.text ?? null;
}
