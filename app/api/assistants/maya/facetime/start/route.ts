import { z } from "zod";

import { errorFields, logger } from "@/lib/logger";
import { serverEnv } from "@/lib/env";
import { getTranslations } from "@/lib/i18n";
import { attachProviderCall, endCallSession } from "@/server/call/binding";
import { prepareCall } from "@/server/call/prepare";
import { rememberRenderSession } from "@/server/call/render-sessions";
import {
  createLiveSession,
  liveModel,
  liveSessionConfig,
} from "@/server/call/openai-live";
import {
  createEchoConversation,
  endEchoConversation,
} from "@/server/call/tavus";

/**
 * Starts the FaceTime prototype.
 *
 * OpenAI Live is still the voice agent. Tavus is asked only for an echo
 * conversation — a Daily room that will lip-sync PCM we send later. The
 * binding is `openai_realtime` because that is whose words and tools this
 * call runs; Tavus never receives instructions, tools or a voice id.
 *
 * The extra instruction is a denial: the prototype does not attach the
 * camera to perception, and Maya must not claim to see the user.
 */
const bodySchema = z.object({
  sdp: z.string().min(1).max(200_000),
  threadId: z.uuid().nullish(),
  timezone: z.string().min(1).max(64).default("UTC"),
});

const CAMERA_DENIAL = `
## This is a video prototype

You cannot see the user. There is no camera feed in this session. Do not
comment on their appearance, room, or expression, and do not ask them to
hold something up to the camera.
`;

export async function POST(req: Request) {
  const env = serverEnv();
  if (env.CALL_ENABLED !== "true" || env.FACETIME_PROTOTYPE_ENABLED !== "true") {
    return Response.json({ error: "FaceTime prototype is not enabled" }, { status: 404 });
  }
  if (!env.TAVUS_API_KEY || !env.TAVUS_PAL_ID) {
    return Response.json(
      { error: "Tavus prototype is not configured" },
      { status: 503 }
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const t = await getTranslations();
  const prepared = await prepareCall({
    timezone: parsed.data.timezone,
    threadId: parsed.data.threadId,
    threadTitle: t.maya.facetime.threadTitle,
    channel: "facetime",
    provider: "openai_realtime",
  });
  if (!prepared.ok) {
    return prepared.response;
  }

  const { scope, threadId, instructions, binding } = prepared.call;
  let conversationId: string | null = null;

  try {
    const [{ answerSdp, providerCallId }, render] = await Promise.all([
      createLiveSession({
        offerSdp: parsed.data.sdp,
        session: liveSessionConfig({
          instructions: `${instructions}\n${CAMERA_DENIAL}`,
        }),
      }),
      createEchoConversation({
        palId: env.TAVUS_PAL_ID,
        conversationName: `facetime-prototype-${binding.callSessionId}`,
      }),
    ]);

    conversationId = render.conversationId;
    await attachProviderCall(binding, providerCallId);
    rememberRenderSession(binding.callSessionId, render.conversationId);

    logger.info("facetime.started", {
      workspaceId: scope.workspaceId,
      threadId,
      callSessionId: binding.callSessionId,
      model: liveModel(),
    });

    return Response.json({
      callSessionId: binding.callSessionId,
      threadId,
      answerSdp,
      maxMinutes: env.CALL_MAX_MINUTES,
      render: {
        conversationId: render.conversationId,
        conversationUrl: render.conversationUrl,
      },
    });
  } catch (error) {
    if (conversationId) {
      await endEchoConversation(conversationId).catch(() => undefined);
    }
    await endCallSession(binding, "provider_error", "failed");
    logger.error("facetime.start_failed", {
      workspaceId: scope.workspaceId,
      callSessionId: binding.callSessionId,
      ...errorFields(error),
    });
    return Response.json(
      { error: "Could not start the video prototype" },
      { status: 502 }
    );
  }
}
