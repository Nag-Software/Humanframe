import { defineTool } from "eve/tools";
import { z } from "zod";

import { completeCommitment } from "../lib/commitments";
import { resolveMemoryScope } from "../lib/session-scope";

/**
 * Close a commitment. A timer still sleeping on it finds it closed when it
 * wakes, and delivers nothing.
 */
export default defineTool({
  description:
    "Mark a commitment as handled, once you have actually done what you promised.",
  inputSchema: z.object({
    commitmentId: z.string().uuid(),
  }),
  async execute(input, ctx) {
    const scope = await resolveMemoryScope(ctx.session);
    if (!scope) {
      return { completed: false };
    }
    const completed = await completeCommitment(
      { client: scope.client, workspaceId: scope.workspaceId, assistantId: scope.assistantId },
      input.commitmentId
    );
    return { completed };
  },
});
