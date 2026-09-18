import { defineTool } from "eve/tools";
import { z } from "zod";

import { createGoal } from "../lib/goals";
import { resolveMemoryScope } from "../lib/session-scope";
import { resolveSessionTarget } from "../lib/session-target";

/**
 * Keep a standing intention. A goal has a direction, not a date; when it
 * needs a date, that is a commitment (`schedule_followup`) made in its
 * service.
 */
export default defineTool({
  description:
    "Record something the user is working towards over time — a goal, not a " +
    "deadline. Use it when they state an aim that will take several steps " +
    "(\"hire two engineers this quarter\", \"close the Nordvik deal\"). For " +
    "a single thing due on a date, use schedule_followup instead.",
  inputSchema: z.object({
    title: z
      .string()
      .min(3)
      .max(200)
      .describe("The goal, in the user's own terms"),
    detail: z
      .string()
      .max(2000)
      .nullable()
      .describe("What success looks like, and what you know about it"),
    priority: z
      .enum(["low", "normal", "high"])
      .nullable()
      .describe("How much it matters relative to their other goals"),
    targetDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .describe("A target date, YYYY-MM-DD, only if the user gave one"),
  }),
  async execute(input, ctx) {
    const scope = await resolveMemoryScope(ctx.session);
    if (!scope) {
      return { recorded: false, note: "This session has no workspace to record in." };
    }

    const target = await resolveSessionTarget({
      sessionId: ctx.session.id,
      userId: scope.userId,
    });

    const goal = await createGoal(
      { client: scope.client, workspaceId: scope.workspaceId, assistantId: scope.assistantId },
      {
        title: input.title,
        detail: input.detail,
        priority: input.priority ?? "normal",
        targetDate: input.targetDate,
        userId: scope.userId,
        sourceThreadId: target?.threadId ?? null,
        // Replay-stable: a retried step claims the same row.
        dedupeKey: `call:${ctx.callId}`,
      }
    );

    return { recorded: true, goalId: goal.id, title: goal.title };
  },
});
