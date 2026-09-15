import { defineTool } from "eve/tools";
import { z } from "zod";

import { resolveMemoryScope } from "../lib/session-scope";

/** What you have promised, and what is overdue. Read-only, so no approval. */
export default defineTool({
  description:
    "List what you have promised to come back to: what is still scheduled, what " +
    "is overdue, and what has been handled.",
  inputSchema: z.object({
    includeFinished: z
      .boolean()
      .nullable()
      .describe("Include commitments that are done or cancelled"),
  }),
  async execute(input, ctx) {
    const scope = await resolveMemoryScope(ctx.session);
    if (!scope) {
      return { commitments: [] };
    }

    let query = scope.client
      .from("commitments")
      .select("id, title, detail, due_at, due_timezone, status, kind")
      .eq("workspace_id", scope.workspaceId)
      .eq("assistant_id", scope.assistantId)
      .order("due_at", { ascending: true })
      .limit(50);

    if (!input.includeFinished) {
      query = query.not("status", "in", '("done","cancelled")');
    }

    const { data } = await query;
    return { commitments: data ?? [] };
  },
  /** An empty list is good news, and the user still has to be told. */
  toModelOutput(output) {
    if (output.commitments.length === 0) {
      return {
        type: "text",
        value:
          "There are no open commitments. Tell the user that in one sentence; " +
          "do not end the turn without it.",
      };
    }
    return { type: "json", value: output };
  },
});
