import { defineDynamic } from "eve/tools";
import { defineInstructions } from "eve/instructions";

import { buildContextPackage } from "../lib/context-package";
import { resolveMemoryScope } from "../lib/session-scope";

/**
 * Injects the context package before each turn.
 *
 * It runs at `turn.started` so retrieval can use what the user just said. The
 * result is system-role text, so it stays outside conversation history and
 * never grows it.
 */
export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      const scope = await resolveMemoryScope(ctx.session);
      if (!scope) {
        return null;
      }

      const message = latestUserText(ctx.messages);

      try {
        const context = await buildContextPackage(scope, { message });
        return context ? defineInstructions({ content: context.text }) : null;
      } catch (error) {
        // Memory must never break a turn: Maya answers without it.
        console.error(
          JSON.stringify({
            level: "error",
            event: "context.build_failed",
            message: error instanceof Error ? error.message : String(error),
          })
        );
        return null;
      }
    },
  },
});

type Message = { role: string; content: unknown };

function latestUserText(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            typeof part === "object" &&
            part !== null &&
            (part as { type?: string }).type === "text"
        )
        .map((part) => part.text)
        .join("\n");
      if (text.trim().length > 0) {
        return text;
      }
    }
  }
  return null;
}
