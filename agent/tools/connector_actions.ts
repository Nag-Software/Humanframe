import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { resolveMemoryScope } from "../lib/session-scope";

/**
 * The connector gateway's model-facing surface.
 *
 * eve compiles authored tools at build time, so the naive reading is that a
 * database-driven action set needs a deploy. `defineDynamic` is the way out:
 * the resolver runs per session and returns the tool map for *this* caller.
 * What the model can see is therefore decided by the register and the caller's
 * grants at session start, and enabling an action is a row update.
 *
 * Three constraints shape the code below, all of them eve's:
 *
 *  - Callback bodies must be written inline in an authored module. eve snapshots
 *    them for durable replay; `execute: makeExecutor()` is not transformed and
 *    is rejected. So the loop builds `defineTool` literals rather than calling
 *    a factory.
 *  - Closure values must be JSON-serializable. Each tool closes over strings
 *    only — an action key and an account id — and looks everything else up live
 *    when it runs. That is also the security property we want: nothing about
 *    authorization is frozen into the tool at discovery time.
 *  - The resolver is on `session.started`, not `turn.started`, because only
 *    session-scoped callbacks are rebound after a redeploy. A parked approval
 *    must survive one; a turn-scoped tool's parked call would error.
 *
 * Freshness is not sacrificed for that: the executor re-checks the account,
 * the grant, the register row and the schema immediately before every call, so
 * a grant revoked after discovery fails at execution. And if the resolver stops
 * returning a tool, eve fails a parked call closed rather than invoking
 * something else.
 */
export default defineDynamic({
  events: {
    async "session.started"(_event, ctx) {
      const scope = await resolveMemoryScope(ctx.session);
      if (!scope) {
        // No Supabase principal: no connector reaches this session.
        return null;
      }

      const { discoverActions } = await import("../../server/connectors/discovery");
      const available = await discoverActions({
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        assistantId: scope.assistantId,
      });

      if (available.length === 0) {
        return null;
      }

      // eve infers a distinct tool type per entry; the map is heterogeneous.
      const tools: Record<string, unknown> = {};

      for (const action of available) {
        // Only these two strings are captured. Everything else is resolved at
        // call time, from the database, by the executor.
        const actionKey = action.actionKey;
        const accountId = action.accountId;

        tools[action.toolName] = defineTool({
          description: action.description,
          inputSchema: z.object({
            query: z
              .string()
              .max(400)
              .nullish()
              .describe("Search terms, when the action takes them"),
            threadId: z
              .string()
              .max(200)
              .nullish()
              .describe("Provider thread or message id, when reading one"),
            to: z.array(z.string()).nullish().describe("Recipients"),
            cc: z.array(z.string()).nullish(),
            bcc: z.array(z.string()).nullish(),
            subject: z.string().max(500).nullish(),
            body: z.string().max(100_000).nullish(),
            limit: z.number().int().min(1).max(25).nullish(),
          }),
          async execute(input, toolCtx) {
            const { runAction } = await import("../../server/connectors/executor");
            return runAction({
              actionKey,
              accountId,
              args: input,
              callId: toolCtx.callId,
              sessionId: toolCtx.session.id,
            });
          },
        });
      }

      return tools as never;
    },
  },
});
