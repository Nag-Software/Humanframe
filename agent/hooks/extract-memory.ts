import { defineHook } from "eve/hooks";

import {
  extractCandidates,
  mirrorFactsIntoMemories,
  storeCandidates,
} from "../lib/memory-extraction";
import { resolveMemoryScope } from "../lib/session-scope";

/**
 * Learns from a finished exchange.
 *
 * It runs after `turn.completed`, never before the answer is delivered, and it
 * is deliberately not awaited by anything the user is waiting on. A failure
 * here loses a memory; it must never lose a reply.
 */
const MIN_USER_CHARACTERS = 12;

type TurnBuffer = {
  userText: string;
  assistantText: string;
  threadId: string | null;
  /** eve's own event id, resolved to our message row before it is stored. */
  eventId: string | null;
  occurredAt: string;
};

const buffers = new Map<string, TurnBuffer>();

function bufferFor(sessionId: string, turnId: string): TurnBuffer {
  const key = `${sessionId}:${turnId}`;
  const existing = buffers.get(key);
  if (existing) {
    return existing;
  }
  const created: TurnBuffer = {
    userText: "",
    assistantText: "",
    threadId: null,
    eventId: null,
    occurredAt: new Date().toISOString(),
  };
  buffers.set(key, created);
  return created;
}

export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      const buffer = bufferFor(ctx.session.id, event.data.turnId);
      buffer.userText = event.data.message ?? "";
      buffer.eventId = event.meta?.id ?? null;
      buffer.occurredAt = event.meta?.at ?? buffer.occurredAt;
    },

    async "message.completed"(event, ctx) {
      if (event.data.message === null) {
        return;
      }
      const buffer = bufferFor(ctx.session.id, event.data.turnId);
      buffer.assistantText = event.data.message;
    },

    async "turn.failed"(event, ctx) {
      // Nothing is learned from a failed turn.
      buffers.delete(`${ctx.session.id}:${event.data.turnId}`);
    },

    async "turn.completed"(event, ctx) {
      const key = `${ctx.session.id}:${event.data.turnId}`;
      const buffer = buffers.get(key);
      buffers.delete(key);

      if (!buffer || buffer.userText.trim().length < MIN_USER_CHARACTERS) {
        return;
      }

      const scope = await resolveMemoryScope(ctx.session);
      if (!scope) {
        return;
      }

      const { data: thread } = await scope.client
        .from("threads")
        .select("id")
        .eq("eve_session_id", ctx.session.id)
        .maybeSingle<{ id: string }>();

      // persist-turn stores eve's event id on the message row, so the event id
      // the hook carries resolves to the message a memory came from.
      const { data: message } = buffer.eventId
        ? await scope.client
            .from("messages")
            .select("id")
            .eq("thread_id", thread?.id ?? "")
            .eq("source_message_id", buffer.eventId)
            .maybeSingle<{ id: string }>()
        : { data: null };

      const source = {
        threadId: thread?.id ?? null,
        messageId: message?.id ?? null,
        occurredAt: buffer.occurredAt,
      };

      try {
        const candidates = await extractCandidates({
          userText: buffer.userText,
          assistantText: buffer.assistantText,
        });

        if (candidates.length === 0) {
          return;
        }

        const result = await storeCandidates(scope, candidates, source);
        await mirrorFactsIntoMemories(scope, candidates, source);

        console.log(
          JSON.stringify({
            level: "info",
            event: "memory.extracted",
            sessionId: ctx.session.id,
            ...result,
          })
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "memory.extraction_failed",
            sessionId: ctx.session.id,
            message: error instanceof Error ? error.message : String(error),
          })
        );
      }
    },
  },
});
