import { headers } from "next/headers";
import { z } from "zod";

import { errorFields, logger } from "@/lib/logger";
import { getAgentRuntime } from "@/server/agent/runtime/eve-runtime";
import { getAssistantBySlug } from "@/server/db/repositories/assistants";
import { ensureThreadForSession } from "@/server/db/repositories/threads";
import { getRequestScope } from "@/server/db/request-scope";

const bodySchema = z.object({
  message: z.string().min(1).max(20000),
});

/**
 * Starts a conversation.
 *
 * The server creates the eve session, then claims the thread that owns it.
 * `eve_session_id` is unique, so the whole thing is idempotent, and the
 * database mints the id the URL will carry — the eve session id is never a
 * public identifier.
 */
export async function POST(req: Request) {
  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const assistant = await getAssistantBySlug(
    scope.client,
    scope.workspaceId,
    "maya"
  );
  if (!assistant) {
    return Response.json({ error: "Assistant not found" }, { status: 404 });
  }

  const cookie = (await headers()).get("cookie");
  const runtime = getAgentRuntime({ cookie });

  try {
    const session = await runtime.startSession({
      workspaceId: scope.workspaceId,
      assistantId: assistant.id,
      threadId: "",
      channel: "chat",
      message: [{ type: "text", text: parsed.data.message }],
    });

    const threadId = await ensureThreadForSession(scope, {
      eveSessionId: session.sessionId,
      assistantId: assistant.id,
      title: parsed.data.message,
    });

    logger.info("maya.session_started", {
      workspaceId: scope.workspaceId,
      threadId,
      sessionId: session.sessionId,
    });

    return Response.json({ threadId, sessionId: session.sessionId });
  } catch (error) {
    logger.error("maya.session_start_failed", {
      workspaceId: scope.workspaceId,
      ...errorFields(error),
    });
    return Response.json({ error: "Could not start session" }, { status: 502 });
  }
}
