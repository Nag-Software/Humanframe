import { defineTool } from "eve/tools";
import { z } from "zod";

import { cancelCommitment } from "../lib/commitments";
import { resolveMemoryScope } from "../lib/session-scope";

/**
 * Drop a commitment the user no longer wants.
 *
 * Cancelling is enough on its own: a cancelled commitment is not in a claimable
 * state, so its timer wakes, finds nothing to claim, and ends without
 * delivering anything or starting a turn.
 */
export default defineTool({
  description:
    "Cancel a commitment the user no longer wants you to come back to.",
  inputSchema: z.object({
    commitmentId: z.string().uuid(),
  }),
  async execute(input, ctx) {
    const scope = await resolveMemoryScope(ctx.session);
    if (!scope) {
      return { cancelled: false };
    }
    const cancelled = await cancelCommitment(
      { client: scope.client, workspaceId: scope.workspaceId, assistantId: scope.assistantId },
      input.commitmentId
    );
    return { cancelled };
  },
});
