import { defineTool } from "eve/tools";
import { z } from "zod";

import { setGoalStatus } from "../lib/goals";
import { resolveMemoryScope } from "../lib/session-scope";

/** Close, pause or reopen a goal. Reversible, so no approval. */
export default defineTool({
  description:
    "Change a goal's status: achieved when the user says it is done, dropped " +
    "when they no longer want it, paused when it is on hold, active to pick " +
    "it back up. Say the new status back to them.",
  inputSchema: z.object({
    goalId: z.string().uuid().describe("The goal, from list_goals"),
    status: z.enum(["active", "paused", "achieved", "dropped"]),
  }),
  async execute(input, ctx) {
    const scope = await resolveMemoryScope(ctx.session);
    if (!scope) {
      return { updated: false, note: "This session has no workspace." };
    }

    const goal = await setGoalStatus(
      { client: scope.client, workspaceId: scope.workspaceId, assistantId: scope.assistantId },
      input.goalId,
      input.status
    );

    if (!goal) {
      return { updated: false, note: "No such goal in this workspace." };
    }
    return { updated: true, goalId: goal.id, title: goal.title, status: goal.status };
  },
});
