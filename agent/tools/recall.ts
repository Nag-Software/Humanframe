import { defineTool } from "eve/tools";
import { z } from "zod";

import { searchMemories } from "../lib/memory-store";
import { resolveMemoryScope } from "../lib/session-scope";

const MAX_RESULTS = 8;

/**
 * Read-only search over Maya's own memory.
 *
 * The context package already carries profile, preferences and the memories
 * that match the current message, so this is for the long tail: an older
 * episode, a detail, a decision the package did not surface. It is scoped to
 * the caller's workspace and assistant by the session, never by an argument,
 * so it cannot reach another tenant's data. Reading memory changes nothing, so
 * it needs no approval.
 */
export default defineTool({
  description:
    "Search your own memory of this user for past events, decisions or details. " +
    "Use it when you need something that is not already in the context you were " +
    "given. Returns the memories with the conversation each came from.",
  inputSchema: z.object({
    query: z
      .string()
      .min(2)
      .max(400)
      .describe("What you are trying to remember, in natural language"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESULTS)
      .optional()
      .describe(`How many memories to return (max ${MAX_RESULTS})`),
  }),
  async execute(input, ctx) {
    const scope = await resolveMemoryScope(ctx.session);
    if (!scope) {
      return { memories: [], note: "No memory is available for this session." };
    }

    const memories = await searchMemories(scope, {
      query: input.query,
      limit: Math.min(input.limit ?? 5, MAX_RESULTS),
    });

    return {
      memories: memories.map((memory) => ({
        id: memory.id,
        content: memory.content,
        kind: memory.kind,
        confidence: Number(memory.confidence.toFixed(2)),
        occurredAt: memory.occurred_at,
        source: {
          threadId: memory.source_thread_id,
          messageId: memory.source_message_id,
        },
      })),
    };
  },
});
