import { defineHook } from "eve/hooks";

import { MIN_USER_CHARACTERS } from "../lib/memory-extraction";
import {
  extractTurnMemory,
  runExtractTurnMemory,
} from "../lib/memory-extraction-workflow";

/**
 * Learns from a finished exchange.
 *
 * eve awaits hook handlers before it emits `session.waiting`, which is when
 * the composer unlocks. The model call therefore cannot live in this handler:
 * it is started as a detached workflow, and a failure there loses a memory
 * rather than the reply the user is looking at.
 */
type TurnBuffer = {
  userText: string;
  assistantText: string;
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
    eventId: null,
    occurredAt: new Date().toISOString(),
  };
  buffers.set(key, created);
  return created;
}

function supabaseUserId(session: {
  auth: {
    initiator?: { principalId?: string; authenticator?: string } | null;
    current?: { principalId?: string; authenticator?: string } | null;
  };
}): string | undefined {
  const principal = session.auth.initiator ?? session.auth.current;
  if (principal?.authenticator !== "supabase" || !principal.principalId) {
    return undefined;
  }
  return principal.principalId;
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

      const userId = supabaseUserId(ctx.session);
      if (!userId) {
        return;
      }

      const input = {
        sessionId: ctx.session.id,
        userId,
        userText: buffer.userText,
        assistantText: buffer.assistantText,
        eventId: buffer.eventId,
        occurredAt: buffer.occurredAt,
      };

      // `start()` cannot live in the workflow module: the bundle forbids
      // importing `workflow/api` from a `"use workflow"` file.
      try {
        const { start } = await import("workflow/api");
        await start(extractTurnMemory, [input]);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "memory.extraction_start_failed",
            sessionId: ctx.session.id,
            message: error instanceof Error ? error.message : String(error),
          })
        );
        void runExtractTurnMemory(input);
      }
    },
  },
});
