import { defineTool } from "eve/tools";
import { z } from "zod";

import { createCommitment } from "../lib/commitments";
import { commitmentTimer } from "../lib/commitment-timer";
import { resolveMemoryScope } from "../lib/session-scope";
import { resolveSessionTarget } from "../lib/session-target";

/**
 * Promise to come back to something.
 *
 * Writing the row is the commitment; starting the timer is how it fires. The
 * two are not transactional, so a crash between them leaves a commitment with
 * no clock — which is exactly what the heartbeat exists to sweep up. That is
 * why a failed `start` is logged and swallowed rather than failing the tool:
 * the promise to the user is the row, not the workflow.
 */
export default defineTool({
  description:
    "Promise to follow up on something at a specific time. Use it when the user " +
    "asks to be reminded, or when you commit to coming back to something. The " +
    "deadline must be an absolute instant — resolve 'Friday' against the user's " +
    "timezone first, and say the resolved date back to them.",
  inputSchema: z.object({
    title: z
      .string()
      .min(3)
      .max(200)
      .describe("What you are coming back to, in the user's own terms"),
    detail: z
      .string()
      .max(2000)
      .nullable()
      .describe("What you will need to know when this comes up again"),
    dueAt: z
      .string()
      .describe("When it is due, ISO 8601 with an explicit offset"),
    kind: z
      .enum(["follow_up", "remind", "deliver"])
      .describe("follow_up: you chase it. remind: you tell them. deliver: you produce something."),
  }),
  async execute(input, ctx) {
    const scope = await resolveMemoryScope(ctx.session);
    if (!scope) {
      return { scheduled: false, note: "This session has no workspace to schedule in." };
    }

    const target = await resolveSessionTarget({
      sessionId: ctx.session.id,
      userId: scope.userId,
    });
    if (!target) {
      return { scheduled: false, note: "This conversation is not stored yet." };
    }

    const dueAt = new Date(input.dueAt);
    if (Number.isNaN(dueAt.getTime())) {
      return { scheduled: false, note: `"${input.dueAt}" is not a date I can use.` };
    }

    const commitment = await createCommitment(
      { client: scope.client, workspaceId: scope.workspaceId, assistantId: scope.assistantId },
      {
        threadId: target.threadId,
        title: input.title,
        detail: input.detail,
        dueAt: dueAt.toISOString(),
        dueTimezone: timezoneOf(input.dueAt),
        kind: input.kind,
        userId: scope.userId,
        sourceThreadId: target.threadId,
        // Replay-stable: a retried step claims the same row instead of making
        // a second promise about the same thing.
        dedupeKey: `call:${ctx.callId}`,
      }
    );

    await startTimer(commitment.id, commitment.due_at);

    return {
      scheduled: true,
      commitmentId: commitment.id,
      dueAt: commitment.due_at,
    };
  },
});

async function startTimer(commitmentId: string, dueAt: string): Promise<void> {
  try {
    const { start } = await import("workflow/api");
    await start(commitmentTimer, [{ commitmentId, dueAt }]);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "commitment.timer_start_failed",
        commitmentId,
        error: error instanceof Error ? error.message : String(error),
        note: "the heartbeat will pick this commitment up when it falls due",
      })
    );
  }
}

/** The offset the user's deadline was expressed in, kept for display. */
function timezoneOf(iso: string): string {
  const match = /([+-]\d{2}:\d{2}|Z)$/.exec(iso.trim());
  if (!match) {
    return "UTC";
  }
  return match[1] === "Z" ? "UTC" : `UTC${match[1]}`;
}
