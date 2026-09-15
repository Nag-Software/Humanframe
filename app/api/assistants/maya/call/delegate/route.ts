import { z } from "zod";

import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { loadCallBinding } from "@/server/call/binding";
import { runDelegation } from "@/server/call/delegation";
import { hasExpired } from "@/server/call/limits";
import { getRequestScope } from "@/server/db/request-scope";

/**
 * Does the backend work a call asked for.
 *
 * The browser relays the provider's delegation here and relays the answer
 * back. It is a transport, not a participant: the workspace, the assistant,
 * the thread and the user are read from the stored call binding, so the only
 * thing the relay influences is what gets asked — never whose data answers it.
 *
 * The provider has no database credential, no network path to Supabase and no
 * way to reach this route except through a browser already signed in as the
 * call's owner.
 */
const bodySchema = z.object({
  callSessionId: z.uuid(),
  delegationId: z.string().min(1).max(128),
  transcript: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().min(1).max(4_000),
      })
    )
    .max(24),
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
  if (binding.status === "ended" || binding.status === "failed") {
    return Response.json({ error: "Call has ended" }, { status: 409 });
  }
  if (hasExpired(binding.startedAt)) {
    return Response.json({ error: "Call has expired" }, { status: 409 });
  }

  const result = await runDelegation({
    binding,
    transcript: parsed.data.transcript,
    // The agent's routes run their own auth walk on this origin, so the
    // signed-in user's cookie is forwarded rather than a service identity.
    cookie: req.headers.get("cookie"),
    origin: new URL(req.url).origin,
  });

  // Whether it answered, never what was said: a transcript of the user's
  // question does not belong in a log line.
  logger.info("call.delegation_completed", {
    callSessionId: binding.callSessionId,
    answered: result.answered,
  });

  return Response.json({ content: result.content });
}
