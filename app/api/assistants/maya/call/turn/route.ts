import { z } from "zod";

import { serverEnv } from "@/lib/env";
import { loadCallBinding } from "@/server/call/binding";
import {
  learnFromCallExchange,
  previousUserTurn,
  recordCallTurn,
} from "@/server/call/transcript";
import { getRequestScope } from "@/server/db/request-scope";

/**
 * Persists one finished spoken turn.
 *
 * Only whole turns arrive here — the adapter in the browser drops every partial
 * transcript before relaying — and the write is idempotent on the turn's own
 * provider id, so a reconnect or a repeated relay produces one message, not
 * two. Because each turn is written as it finishes, hang-up is not a
 * persistence point: closing the tab loses nothing that was already said.
 */
const bodySchema = z.object({
  callSessionId: z.uuid(),
  sourceId: z.string().min(1).max(128),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(20_000),
  interrupted: z.boolean().optional(),
});

export async function POST(req: Request) {
  if (serverEnv().CALL_ENABLED !== "true") {
    return Response.json({ error: "Call is not enabled" }, { status: 404 });
  }

  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const binding = await loadCallBinding({
    callSessionId: parsed.data.callSessionId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
  });

  if (!binding) {
    return Response.json({ error: "Unknown call" }, { status: 404 });
  }

  const recorded = await recordCallTurn(binding, {
    sourceId: parsed.data.sourceId,
    role: parsed.data.role,
    text: parsed.data.text,
    interrupted: parsed.data.interrupted,
  });

  if (!recorded) {
    return Response.json({ error: "Could not record turn" }, { status: 500 });
  }

  // Learn from the exchange once, when the reply is first written and the user
  // actually heard it. A replay returns `created: false` and learns nothing.
  if (
    recorded.created &&
    parsed.data.role === "assistant" &&
    !parsed.data.interrupted
  ) {
    const userText = await previousUserTurn(binding, recorded.turnId);
    if (userText) {
      await learnFromCallExchange(binding, {
        userText,
        assistantText: parsed.data.text,
        messageId: recorded.messageId,
      });
    }
  }

  return Response.json({
    messageId: recorded.messageId,
    created: recorded.created,
  });
}
