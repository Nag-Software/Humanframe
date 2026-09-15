import { z } from "zod";

import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { loadCallBinding } from "@/server/call/binding";
import { hasExpired } from "@/server/call/limits";
import { executeCallTool } from "@/server/call/tools";
import { getRequestScope } from "@/server/db/request-scope";

/**
 * Runs one tool for a call.
 *
 * The browser relays the model's tool call here and relays the result back. It
 * is a transport, not a participant: the workspace, the assistant, the thread
 * and the user are read from the stored call binding, so the only thing the
 * relay can influence is which of three named tools runs and with what
 * arguments — never whose data it touches.
 *
 * Realtime itself has no database credential, no network path to Supabase and
 * no way to reach this route except through a browser that is already signed
 * in as the call's owner.
 */
const bodySchema = z.object({
  callSessionId: z.uuid(),
  name: z.string().min(1).max(64),
  callId: z.string().min(1).max(128),
  args: z.unknown().optional(),
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

  const result = await executeCallTool(
    binding,
    parsed.data.name,
    parsed.data.args ?? {},
    parsed.data.callId
  );

  // The tool name and outcome, never the arguments or the output: a transcript
  // of what the user asked for does not belong in a log line.
  logger.info("call.tool_executed", {
    callSessionId: binding.callSessionId,
    tool: parsed.data.name,
    ok: result.ok,
  });

  return Response.json({ output: result.output });
}
