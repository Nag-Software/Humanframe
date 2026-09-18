import { z } from "zod";

import { errorFields, logger } from "@/lib/logger";
import { serverEnv } from "@/lib/env";
import { getTranslations } from "@/lib/i18n";
import { attachProviderCall, endCallSession } from "@/server/call/binding";
import { allowedMinutes, prepareCall } from "@/server/call/prepare";
import {
  createLiveSession,
  liveModel,
  liveSessionConfig,
} from "@/server/call/openai-live";

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

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const t = await getTranslations();
  const prepared = await prepareCall({
    timezone: parsed.data.timezone,
    threadId: parsed.data.threadId,
    threadTitle: t.maya.call.threadTitle,
    channel: "live",
    provider: "openai_realtime",
    kind: "voice",
  });
  if (!prepared.ok) {
    return prepared.response;
  }

  const { scope, threadId, instructions, binding } = prepared.call;

  try {
    const { answerSdp, providerCallId } = await createLiveSession({
      offerSdp: parsed.data.sdp,
      session: liveSessionConfig({ instructions }),
    });

    await attachProviderCall(binding, providerCallId);

    logger.info("call.started", {
      workspaceId: scope.workspaceId,
      threadId,
      callSessionId: binding.callSessionId,
      model: liveModel(),
    });

    return Response.json({
      callSessionId: binding.callSessionId,
      threadId,
      answerSdp,
      maxMinutes: allowedMinutes(binding.allowedSeconds, env.CALL_MAX_MINUTES),
      limitMessage: t.maya.call.limits.minutesUsedUp,
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
