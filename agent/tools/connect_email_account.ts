import { defineTool } from "eve/tools";
import { z } from "zod";

import { resolveMemoryScope } from "../lib/session-scope";

/**
 * Offers the user a link to connect their own mailbox.
 *
 * Three things this deliberately does not do.
 *
 * It takes no user id. The subject Composio files an account under decides
 * whose inbox is reachable, so it comes from the authenticated eve session and
 * nowhere else — never a request body, never a model argument.
 *
 * It takes no toolkit name. The model chooses between two providers we have
 * pinned to least-privilege auth configs, not from Composio's whole catalogue.
 *
 * It connects nothing. It returns a link; a person authorises in their own
 * browser, and the binding is only written after the callback proves the
 * account belongs to them.
 */
export default defineTool({
  description:
    "Give the user a link to connect their own Gmail or Outlook mailbox. Use it " +
    "when they ask you to work with their email and no account is connected " +
    "yet, or when the connected one has stopped working. This only produces a " +
    "link — it cannot read or send anything.",
  inputSchema: z.object({
    provider: z
      .enum(["gmail", "outlook"])
      .describe("Which mailbox the user wants to connect"),
  }),
  async execute(input, ctx) {
    const scope = await resolveMemoryScope(ctx.session);
    if (!scope) {
      return {
        offered: false,
        note: "This session has no signed-in user to connect an account for.",
      };
    }

    // Imported lazily: the eve bundle should not carry the connector stack
    // unless a call actually reaches it.
    const [
      { beginAuthorization, bindAccount },
      { createAuthorizationLink },
      { appOrigin },
    ] = await Promise.all([
      import("../../server/connectors/accounts"),
      import("../../server/connectors/composio"),
      import("../lib/email-template"),
    ]);

    try {
      const state = await beginAuthorization({
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        provider: input.provider,
      });

      const origin = appOrigin(process.env);
      const outcome = await createAuthorizationLink({
        provider: input.provider,
        composioUserId: scope.userId,
        callbackUrl: `${origin}/api/connectors/callback?state=${state}`,
      });

      if (outcome.kind === "already_connected") {
        await bindAccount({
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          provider: input.provider,
          composioUserId: scope.userId,
          connectedAccountId: outcome.connectedAccountId,
          accountEmail: outcome.email,
        });
        return {
          offered: false,
          provider: input.provider,
          note: "This mailbox is already connected.",
        };
      }

      return {
        offered: true,
        provider: input.provider,
        redirectUrl: outcome.redirectUrl,
      };
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "connector.link_failed",
          provider: input.provider,
          message: error instanceof Error ? error.message : String(error),
        })
      );
      return {
        offered: false,
        provider: input.provider,
        note: "I could not create a connection link just now.",
      };
    }
  },
  /** The model needs to know it offered a link, not the link itself. */
  toModelOutput(output) {
    return {
      type: "text",
      value: output.offered
        ? `A connect button for ${output.provider} is now shown to the user. Ask them to use it, and wait.`
        : "connected" in output && output.connected
          ? `${output.provider} is already connected. Say so; do not offer a link.`
          : (output.note ?? "The connection link could not be created."),
    };
  },
});
