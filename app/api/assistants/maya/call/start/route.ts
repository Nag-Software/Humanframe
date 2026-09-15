import { z } from "zod";

import { errorFields, logger } from "@/lib/logger";
import { serverEnv } from "@/lib/env";
import { getTranslations } from "@/lib/i18n";
import {
  attachProviderCall,
  createCallSession,
  endCallSession,
} from "@/server/call/binding";
import { buildCallInstructions } from "@/server/call/context";
import { checkCallLimits, reapStaleCalls } from "@/server/call/limits";
import {
  REALTIME_MODEL,
  createRealtimeCall,
  realtimeSessionConfig,
} from "@/server/call/openai-realtime";
import { CALL_TOOLS } from "@/server/call/tools";
import { getAssistantBySlug } from "@/server/db/repositories/assistants";
import {
  ensureThread,
  getThread,
  touchThread,
} from "@/server/db/repositories/threads";
import { getRequestScope } from "@/server/db/request-scope";

/**
 * Starts a call.
 *
 * The browser sends an SDP offer and, optionally, the thread it is calling
 * from. It never sends a key, a workspace, an assistant or a model — all four
 * are decided here, from the signed-in session, and written into the call
 * binding that every later request is answered from.
 *
 * The permanent OpenAI key is used on this side of the boundary only. What goes
 * back is an SDP answer: enough to open one peer connection to one session that
 * is already configured, and useless for anything else.
 */
const bodySchema = z.object({
  sdp: z.string().min(1).max(200_000),
  threadId: z.uuid().nullish(),
  timezone: z.string().min(1).max(64).default("UTC"),
});

export async function POST(req: Request) {
  const env = serverEnv();
  if (env.CALL_ENABLED !== "true") {
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

  const assistant = await getAssistantBySlug(
    scope.client,
    scope.workspaceId,
    "maya"
  );
  if (!assistant) {
    return Response.json({ error: "Assistant not found" }, { status: 404 });
  }

  // A call that was never hung up must not hold the concurrency slot forever.
  await reapStaleCalls(scope.workspaceId);

  const verdict = await checkCallLimits({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
  });
  if (!verdict.allowed) {
    return Response.json(
      { error: verdict.reason, message: verdict.message },
      { status: 429 }
    );
  }

  // The thread is resolved through row level security, so a thread id that
  // belongs to someone else reads as absent and a fresh one is created instead
  // of being joined.
  const t = await getTranslations();
  const threadId = await resolveThread(
    scope,
    assistant.id,
    parsed.data.threadId,
    t.maya.call.threadTitle
  );

  const { instructions } = await buildCallInstructions({
    client: scope.client,
    workspaceId: scope.workspaceId,
    assistantId: assistant.id,
    userId: scope.userId,
    userName: scope.userName,
    timezone: parsed.data.timezone,
  });

  const binding = await createCallSession({
    workspaceId: scope.workspaceId,
    assistantId: assistant.id,
    threadId,
    userId: scope.userId,
    provider: "openai_realtime",
    model: REALTIME_MODEL,
  });

  try {
    const { answerSdp, providerCallId } = await createRealtimeCall({
      offerSdp: parsed.data.sdp,
      session: realtimeSessionConfig({ instructions, tools: CALL_TOOLS }),
    });

    await attachProviderCall(binding, providerCallId);

    logger.info("call.started", {
      workspaceId: scope.workspaceId,
      threadId,
      callSessionId: binding.callSessionId,
      model: REALTIME_MODEL,
    });

    return Response.json({
      callSessionId: binding.callSessionId,
      threadId,
      answerSdp,
      maxMinutes: env.CALL_MAX_MINUTES,
    });
  } catch (error) {
    await endCallSession(binding, "provider_error", "failed");
    logger.error("call.start_failed", {
      workspaceId: scope.workspaceId,
      callSessionId: binding.callSessionId,
      ...errorFields(error),
    });
    return Response.json({ error: "Could not start the call" }, { status: 502 });
  }
}

/**
 * The thread this call belongs to: the one the user was already in, or a new
 * canonical one created through the app's own pattern.
 */
async function resolveThread(
  scope: Awaited<ReturnType<typeof getRequestScope>> & object,
  assistantId: string,
  requested: string | null | undefined,
  title: string
): Promise<string> {
  if (requested) {
    const thread = await getThread(scope, requested);
    if (thread) {
      await touchThread(scope, thread.id, new Date().toISOString());
      return thread.id;
    }
  }

  const threadId = crypto.randomUUID();
  await ensureThread(scope, {
    threadId,
    assistantId,
    channel: "live",
    title,
  });
  return threadId;
}
