import { defineHook } from "eve/hooks";

import { resolveSessionTarget, type SessionTarget } from "../lib/session-target";

/**
 * Projects an eve run into Supabase.
 *
 * eve owns execution state. This hook writes the product's own record of it:
 * messages, a readable agent_runs row per turn, and one tool_calls row per
 * call. Every write is keyed on an identifier eve mints once — the event id and
 * its timestamp, the turn id, the call id — so a replayed step updates the same
 * row instead of creating a second one.
 */
export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      const target = await resolve(ctx);
      if (!target) return;

      const parts = (event.data.parts ?? []).map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : {
              type: "file",
              url: part.url,
              mediaType: part.mediaType,
              filename: part.filename,
            }
      );

      await writeMessage(target, {
        role: "user",
        content: parts.length > 0 ? parts : [{ type: "text", text: "" }],
        sourceMessageId: eventId(event),
        createdAt: eventTime(event),
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },

    async "message.completed"(event, ctx) {
      if (event.data.message === null) return;
      const target = await resolve(ctx);
      if (!target) return;

      await writeMessage(target, {
        role: "assistant",
        content: [{ type: "text", text: event.data.message }],
        sourceMessageId: eventId(event),
        createdAt: eventTime(event),
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },

    async "turn.started"(event, ctx) {
      const target = await resolve(ctx);
      if (!target) return;
      await upsertRun(target, ctx.session.id, event.data.turnId, {
        status: "running",
        started_at: eventTime(event),
      });
    },

    async "turn.completed"(event, ctx) {
      const target = await resolve(ctx);
      if (!target) return;
      await upsertRun(target, ctx.session.id, event.data.turnId, {
        status: "completed",
        ended_at: eventTime(event),
      });
      await target.client
        .from("threads")
        .update({ last_message_at: eventTime(event) })
        .eq("id", target.threadId);
    },

    async "turn.failed"(event, ctx) {
      const target = await resolve(ctx);
      if (!target) return;
      await upsertRun(target, ctx.session.id, event.data.turnId, {
        status: "failed",
        ended_at: eventTime(event),
        error: { code: event.data.code, message: event.data.message },
      });
    },

    async "turn.cancelled"(event, ctx) {
      const target = await resolve(ctx);
      if (!target) return;
      await upsertRun(target, ctx.session.id, event.data.turnId, {
        status: "cancelled",
        ended_at: eventTime(event),
      });
    },

    async "step.completed"(event, ctx) {
      const usage = event.data.usage;
      if (!usage) return;
      const target = await resolve(ctx);
      if (!target) return;

      await upsertRun(target, ctx.session.id, event.data.turnId, {
        input_tokens: usage.inputTokens ?? null,
        output_tokens: usage.outputTokens ?? null,
        cost_usd: usage.costUsd ?? null,
      });
    },

    async "actions.requested"(event, ctx) {
      const target = await resolve(ctx);
      if (!target) return;

      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") continue;
        await upsertToolCall(target, ctx.session.id, event.data.turnId, {
          call_id: action.callId,
          tool_name: action.toolName,
          input: action.input ?? null,
          status: "requested",
          started_at: eventTime(event),
        });
      }
    },

    async "input.requested"(event, ctx) {
      const target = await resolve(ctx);
      if (!target) return;

      for (const request of event.data.requests) {
        if (request.kind !== "tool-approval") continue;
        await upsertToolCall(target, ctx.session.id, event.data.turnId, {
          call_id: request.action.callId,
          tool_name: request.action.toolName,
          input: request.action.input ?? null,
          status: "awaiting_approval",
          risk: "execute_with_approval",
        });
      }
    },

    async "action.result"(event, ctx) {
      const result = event.data.result;
      if (result.kind !== "tool-result") return;
      const target = await resolve(ctx);
      if (!target) return;

      await upsertToolCall(target, ctx.session.id, event.data.turnId, {
        call_id: result.callId,
        tool_name: result.toolName,
        output: (result.output ?? null) as never,
        status: event.data.status === "completed" ? "succeeded" : "failed",
        ended_at: eventTime(event),
      });
    },
  },
});

type HookCtx = { session: { id: string; auth: { initiator?: { principalId?: string; authenticator?: string } | null } } };

async function resolve(ctx: HookCtx): Promise<SessionTarget | null> {
  const initiator = ctx.session.auth.initiator;
  const userId =
    initiator?.authenticator === "supabase" ? initiator.principalId : undefined;

  return resolveSessionTarget({ sessionId: ctx.session.id, userId });
}

function eventTime(event: { meta?: { at?: string } }): string {
  return event.meta?.at ?? new Date().toISOString();
}

function eventId(event: { meta?: { id?: string } }): string | undefined {
  return event.meta?.id;
}

/** Hook failures must be visible; they are never allowed to break the run. */
function report(operation: string, error: unknown): void {
  if (error) {
    console.error(
      JSON.stringify({ level: "error", event: `persist.${operation}`, error })
    );
  }
}

async function writeMessage(
  target: SessionTarget,
  message: {
    role: "user" | "assistant";
    content: unknown[];
    sourceMessageId?: string;
    createdAt: string;
    sessionId: string;
    turnId: string;
  }
): Promise<void> {
  const { error } = await target.client.from("messages").upsert(
    {
      workspace_id: target.workspaceId,
      assistant_id: target.assistantId,
      thread_id: target.threadId,
      channel: "chat",
      role: message.role,
      content: message.content,
      source_message_id: message.sourceMessageId ?? null,
      created_at: message.createdAt,
      eve_session_id: message.sessionId,
      eve_turn_id: message.turnId,
    },
    {
      onConflict: "thread_id,source_message_id,created_at",
      ignoreDuplicates: true,
    }
  );
  report("message", error);
}

async function upsertRun(
  target: SessionTarget,
  sessionId: string,
  turnId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await target.client.from("agent_runs").upsert(
    {
      workspace_id: target.workspaceId,
      assistant_id: target.assistantId,
      thread_id: target.threadId,
      eve_session_id: sessionId,
      eve_turn_id: turnId,
      status: "running",
      ...patch,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "eve_session_id,eve_turn_id" }
  );
  report("agent_run", error);
}

async function upsertToolCall(
  target: SessionTarget,
  sessionId: string,
  turnId: string,
  patch: Record<string, unknown> & { call_id: string; tool_name: string }
): Promise<void> {
  const { data: run, error: runError } = await target.client
    .from("agent_runs")
    .select("id")
    .eq("eve_session_id", sessionId)
    .eq("eve_turn_id", turnId)
    .maybeSingle<{ id: string }>();

  if (!run) {
    report("tool_call_run_lookup", runError ?? { callId: patch.call_id });
    return;
  }

  const { error } = await target.client.from("tool_calls").upsert(
    {
      workspace_id: target.workspaceId,
      // A call keeps its identity across an approval pause, so the row is keyed
      // on the session. run_id points at the turn it last progressed in.
      eve_session_id: sessionId,
      run_id: run.id,
      thread_id: target.threadId,
      ...patch,
    },
    { onConflict: "eve_session_id,call_id" }
  );
  report("tool_call", error);
}
