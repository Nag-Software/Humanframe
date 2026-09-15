import { z } from "zod";

import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { endCallSession, loadCallBinding } from "@/server/call/binding";
import { takeRenderSession } from "@/server/call/render-sessions";
import { endEchoConversation } from "@/server/call/tavus";
import { getRequestScope } from "@/server/db/request-scope";

/**
 * Ends a call.
 *
 * Idempotent, and deliberately not load-bearing: every turn is already durable
 * when this runs. It exists so the concurrency slot is released immediately
 * rather than at the next sweep, and so the record says how the call ended.
 */
const bodySchema = z.object({
  callSessionId: z.uuid(),
  reason: z.enum(["hangup", "navigation", "error", "microphone_denied"]),
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

  const renderId = takeRenderSession(binding.callSessionId);
  if (renderId) {
    await endEchoConversation(renderId).catch(() => undefined);
  }

  await endCallSession(
    binding,
    parsed.data.reason,
    parsed.data.reason === "error" ? "failed" : "ended"
  );

  logger.info("call.ended", {
    callSessionId: binding.callSessionId,
    reason: parsed.data.reason,
  });

  return Response.json({ ok: true });
}
