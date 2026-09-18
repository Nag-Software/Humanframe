import { after } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";

import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { reportCallOverage } from "@/server/billing/overage";
import { billingEnabled } from "@/server/billing/stripe";
import { endCallSession, loadCallBinding } from "@/server/call/binding";
import { takeRenderSession } from "@/server/call/render-sessions";
import { endEchoConversation } from "@/server/call/tavus";
import { traceEndedCall } from "@/server/call/trace";
import { getRequestScope } from "@/server/db/request-scope";

/**
 * Ends a call.
 *
 * Idempotent, and deliberately not load-bearing: every turn is already durable
 * when this runs. It exists so the concurrency slot is released immediately
 * rather than at the next sweep, and so the record says how the call ended.
 *
 * The one thing that follows an ending is the trace: Maya is told the call is
 * over and writes its chapter into the conversation. That happens after the
 * response, once, and only for a call that was actually a call.
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

  const ended = await endCallSession(
    binding,
    parsed.data.reason,
    parsed.data.reason === "error" ? "failed" : "ended"
  );

  logger.info("call.ended", {
    callSessionId: binding.callSessionId,
    reason: parsed.data.reason,
    firstEnding: ended !== null,
  });

  if (ended) {
    // What this call cost beyond the plan is settled the moment it ends,
    // whatever the reason: the minutes were served either way.
    if (billingEnabled()) {
      const plan = scope.workspace.plan;
      after(() =>
        reportCallOverage(getServiceRoleClient(), { binding, plan })
      );
    }

    if (parsed.data.reason !== "error") {
      const cookie = (await headers()).get("cookie");
      const origin = new URL(req.url).origin;
      after(() =>
        traceEndedCall({
          binding,
          ended,
          video: renderId !== null,
          cookie,
          origin,
        })
      );
    }
  }

  return Response.json({ ok: true });
}
