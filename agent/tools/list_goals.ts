import { defineTool } from "eve/tools";
import { z } from "zod";

import { listGoals, priorityLabel } from "../lib/goals";
import { resolveMemoryScope } from "../lib/session-scope";

/** What the user is working towards. Read-only, so no approval. */
export default defineTool({
  description:
    "List the user's goals — what they are working towards over time — with " +
    "priority and status. Use it before proposing what to do next, and when " +
    "asked what is on their plate.",
  inputSchema: z.object({
    includeClosed: z
      .boolean()
      .nullable()
      .describe("Include goals that are achieved or dropped"),
  }),
  async execute(input, ctx) {
    const scope = await resolveMemoryScope(ctx.session);
    if (!scope) {
      return { goals: [] };
    }

    const goals = await listGoals(
      { client: scope.client, workspaceId: scope.workspaceId, assistantId: scope.assistantId },
      { includeClosed: input.includeClosed ?? false }
    );

    return {
      goals: goals.map((goal) => ({
        id: goal.id,
        title: goal.title,
        detail: goal.detail,
        status: goal.status,
        priority: priorityLabel(goal.priority),
        targetDate: goal.target_date,
      })),
    };
  },
  /** An empty list is an answer too, and the user still has to hear it. */
  toModelOutput(output) {
    if (output.goals.length === 0) {
      return {
        type: "text",
        value:
          "There are no recorded goals. Tell the user that in one sentence; " +
          "do not end the turn without it.",
      };
    }
    return { type: "json", value: output };
  },
});
