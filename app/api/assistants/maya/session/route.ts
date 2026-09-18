import { headers } from "next/headers";
import { z } from "zod";

import {
  buildOpeningMessage,
  hasSomethingToOpen,
} from "@/agent/lib/opening";
import { errorFields, logger } from "@/lib/logger";
import { getAgentRuntime } from "@/server/agent/runtime/eve-runtime";
import { billingEnabled } from "@/server/billing/stripe";
import { isEntitled, loadSubscription } from "@/server/billing/subscriptions";
import { getAssistantBySlug } from "@/server/db/repositories/assistants";
import { loadOpeningBrief } from "@/server/db/repositories/opening";
import { ensureThreadForSession } from "@/server/db/repositories/threads";
import { getRequestScope } from "@/server/db/request-scope";
import { LIMITS, rateLimitedResponse, takeRateLimit } from "@/server/rate-limit";

const bodySchema = z.union([
  z.object({ message: z.string().min(1).max(20000) }),
  /** No message: Maya opens the day, if she has something to open it with. */
  z.object({ open: z.literal(true) }),
]);

/**
 * Starts a conversation.
 *
 * The server creates the eve session, then claims the thread that owns it.
 * `eve_session_id` is unique, so the whole thing is idempotent, and the
 * database mints the id the URL will carry — the eve session id is never a
 * public identifier.
 *
 * Two ways in: the user wrote something, or the user arrived and Maya speaks
 * first. The second is decided from data, not by the model: with nothing due
 * and nothing recent the route answers 204 and the composer simply waits.
 */
export async function POST(req: Request) {
  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!(await takeRateLimit(scope.client, LIMITS.sessionStart))) {
    return rateLimitedResponse(LIMITS.sessionStart);
  }

  // No free plan: a workspace without a plan can look, not talk.
  if (billingEnabled()) {
    const subscription = await loadSubscription(scope.client, scope.workspaceId);
    if (!isEntitled(subscription?.status ?? "none")) {
      return Response.json({ error: "no_subscription" }, { status: 402 });
    }
  }

  const assistant = await getAssistantBySlug(
    scope.client,
    scope.workspaceId,
    "maya"
  );
  if (!assistant) {
    return Response.json({ error: "Assistant not found" }, { status: 404 });
  }

  let text: string;
  let title: string | undefined;
  let opening = false;

  if ("open" in parsed.data) {
    const brief = await loadOpeningBrief(scope.client, {
      workspaceId: scope.workspaceId,
      assistantId: assistant.id,
      userId: scope.userId,
    });
    if (!hasSomethingToOpen(brief)) {
      return new Response(null, { status: 204 });
    }
    text = buildOpeningMessage(brief, new Date());
    opening = true;
  } else {
    text = parsed.data.message;
    title = parsed.data.message;
  }

  const cookie = (await headers()).get("cookie");
  const runtime = getAgentRuntime({ cookie, origin: new URL(req.url).origin });

  try {
    const session = await runtime.startSession({
      workspaceId: scope.workspaceId,
      assistantId: assistant.id,
      threadId: "",
      channel: "chat",
      message: [{ type: "text", text }],
    });

    const threadId = await ensureThreadForSession(scope, {
      eveSessionId: session.sessionId,
      assistantId: assistant.id,
      title,
    });

    logger.info("maya.session_started", {
      workspaceId: scope.workspaceId,
      threadId,
      sessionId: session.sessionId,
      opening,
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
