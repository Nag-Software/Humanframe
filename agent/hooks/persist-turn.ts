import { defineHook } from "eve/hooks";

import { isSignal } from "../../lib/signals";
import { notificationDedupeKey, type NotificationEvent } from "../lib/notifications";
import { notificationSender } from "../lib/notification-workflow";
import { resolveSessionTarget, type SessionTarget } from "../lib/session-target";
import { isWakeMessage } from "../lib/wake";

/**
 * Why this turn is running, remembered from the input that started it.
 *
 * A wake marker arriving as user input means the assistant's eventual reply is
 * a reminder; a task completion means it is finished background work. Nothing
 * else produces a notification — and the marker itself never does, because a
 * notification is only ever attached to the *visible* reply.
 */
const turnCause = new Map<string, { event: NotificationEvent; subjectType: "commitment" | "task"; subjectId: string | null }>();

function causeKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

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

      // A signal is Humanframe talking to Maya — a wake, a new day, a call
      // that ended. It is stored so a retry can find its marker, but on the
      // system channel, so it is never filed as something the user said. Only
      // a wake carries a notification: the user is present for the others.
      const first = parts.find((part) => part.type === "text");
      const isSystem = typeof first?.text === "string" && isSignal(first.text);
      const isWake =
        typeof first?.text === "string" && isWakeMessage(first.text);

      if (isWake && typeof first?.text === "string") {
        turnCause.set(causeKey(ctx.session.id, event.data.turnId), {
          event: "reminder",
          subjectType: "commitment",
          subjectId: null,
        });
      }

      await writeMessage(target, {
        role: "user",
        channel: isSystem ? "system" : "chat",
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

      const cause = turnCause.get(causeKey(ctx.session.id, event.data.turnId));

      // The message and its notification are written in one statement, so a
      // replayed hook cannot produce one without the other — and cannot
      // produce two of either.
      const notificationId = await writeMessage(target, {
        role: "assistant",
        content: [{ type: "text", text: event.data.message }],
        sourceMessageId: eventId(event),
        createdAt: eventTime(event),
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
        notify: cause
          ? {
              userId: target.userId,
              event: cause.event,
              subjectType: cause.subjectType,
              subjectId: cause.subjectId,
              dedupeKey: notificationDedupeKey({
                event: cause.event,
                sessionId: ctx.session.id,
                turnId: event.data.turnId,
              }),
            }
          : undefined,
      });

      turnCause.delete(causeKey(ctx.session.id, event.data.turnId));

      if (notificationId) {
        await startNotification(notificationId);
      }
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

        // An approval has no assistant message to hang a notification on: the
        // turn is parked waiting for a person. The notification is keyed on the
        // call, so a re-emitted request produces one job, not one per event.
        const { data: call } = await target.client
          .from("tool_calls")
          .select("id")
          .eq("eve_session_id", ctx.session.id)
          .eq("call_id", request.action.callId)
          .maybeSingle<{ id: string }>();

        if (call) {
          const jobId = await enqueueNotification(target, {
            userId: target.userId,
            event: "approval_needed",
            subjectType: "approval",
            subjectId: call.id,
            dedupeKey: `approval_needed:${ctx.session.id}:${request.action.callId}`,
          });
          if (jobId) {
            await startNotification(jobId);
          }
        }
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

type NotifyRequest = {
  userId: string;
  event: NotificationEvent;
  subjectType: "commitment" | "task" | "approval";
  subjectId: string | null;
  dedupeKey: string;
};

/**
 * Writes one message and, when the turn warrants it, the notification job for
 * it — in a single statement, so the pair is atomic. Returns the notification
 * id when this call is the one that created it.
 */
async function writeMessage(
  target: SessionTarget,
  message: {
    role: "user" | "assistant";
    channel?: "chat" | "system";
    content: unknown[];
    sourceMessageId?: string;
    createdAt: string;
    sessionId: string;
    turnId: string;
    notify?: NotifyRequest;
  }
): Promise<string | null> {
  const { data, error } = await target.client.rpc("record_assistant_message", {
    p_workspace_id: target.workspaceId,
    p_assistant_id: target.assistantId,
    p_thread_id: target.threadId,
    p_role: message.role,
    p_channel: message.channel ?? "chat",
    p_content: message.content,
    p_source_message_id: message.sourceMessageId ?? null,
    p_created_at: message.createdAt,
    p_eve_session_id: message.sessionId,
    p_eve_turn_id: message.turnId,
    p_notify_user_id: message.notify?.userId ?? null,
    p_event_type: message.notify?.event ?? null,
    p_dedupe_key: message.notify?.dedupeKey ?? null,
    p_subject_type: message.notify?.subjectType ?? null,
    p_subject_id: message.notify?.subjectId ?? null,
  });

  report("message", error);
  const row = (data as { notification_id: string | null }[] | null)?.[0];
  return row?.notification_id ?? null;
}

/** An outbox job with no message of its own — an approval request. */
async function enqueueNotification(
  target: SessionTarget,
  notify: NotifyRequest
): Promise<string | null> {
  const { data, error } = await target.client
    .from("notification_outbox")
    .upsert(
      {
        workspace_id: target.workspaceId,
        assistant_id: target.assistantId,
        recipient_user_id: notify.userId,
        thread_id: target.threadId,
        event_type: notify.event,
        subject_type: notify.subjectType,
        subject_id: notify.subjectId,
        dedupe_key: notify.dedupeKey,
      },
      { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true }
    )
    .select("id")
    .maybeSingle<{ id: string }>();

  report("notification", error);
  return data?.id ?? null;
}

/**
 * Starts the job's own durable run, after its row is committed.
 *
 * A failure here is logged and swallowed: the job is already durable, and the
 * daily heartbeat will pick it up. That recovery costs up to about a day, which
 * is why the immediate start exists at all.
 */
async function startNotification(jobId: string): Promise<void> {
  try {
    const { start } = await import("workflow/api");
    await start(notificationSender, [{ jobId }]);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "notification.start_failed",
        jobId,
        error: error instanceof Error ? error.message : String(error),
        note: "the daily heartbeat will send this, up to ~24h later",
      })
    );
  }
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
