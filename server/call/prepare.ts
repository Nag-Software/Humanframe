import { logger } from "@/lib/logger";
import {
  createCallSession,
  type CallBinding,
  type CallProvider,
} from "@/server/call/binding";
import { buildCallInstructions } from "@/server/call/context";
import {
  checkCallLimits,
  endAbandonedCalls,
  reapStaleCalls,
} from "@/server/call/limits";
import { liveModel } from "@/server/call/openai-live";
import { getAssistantBySlug } from "@/server/db/repositories/assistants";
import {
  ensureThread,
  getThread,
  touchThread,
  type Channel,
} from "@/server/db/repositories/threads";
import {
  getRequestScope,
  type RequestScope,
} from "@/server/db/request-scope";

/**
 * Everything a Call and a FaceTime prototype share before they talk to a
 * provider: the signed-in scope, the concurrency slot, the thread, the
 * instructions, the binding. Extracted so the FaceTime route cannot drift
 * from Call on the security model.
 */

export type PreparedCall = {
  scope: RequestScope;
  threadId: string;
  instructions: string;
  binding: CallBinding;
};

export async function prepareCall(input: {
  timezone: string;
  threadId?: string | null;
  threadTitle: string;
  channel: Channel;
  provider: CallProvider;
}): Promise<{ ok: true; call: PreparedCall } | { ok: false; response: Response }> {
  const scope = await getRequestScope();
  if (!scope) {
    return {
      ok: false,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const assistant = await getAssistantBySlug(
    scope.client,
    scope.workspaceId,
    "maya"
  );
  if (!assistant) {
    return {
      ok: false,
      response: Response.json({ error: "Assistant not found" }, { status: 404 }),
    };
  }

  await reapStaleCalls(scope.workspaceId);

  const superseded = await endAbandonedCalls({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
  });
  if (superseded > 0) {
    logger.info("call.superseded", {
      workspaceId: scope.workspaceId,
      count: superseded,
    });
  }

  const verdict = await checkCallLimits({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
  });
  if (!verdict.allowed) {
    return {
      ok: false,
      response: Response.json(
        { error: verdict.reason, message: verdict.message },
        { status: 429 }
      ),
    };
  }

  const threadId = await resolveThread(
    scope,
    assistant.id,
    input.threadId,
    input.threadTitle,
    input.channel
  );

  const { instructions } = await buildCallInstructions({
    client: scope.client,
    workspaceId: scope.workspaceId,
    assistantId: assistant.id,
    userId: scope.userId,
    userName: scope.userName,
    timezone: input.timezone,
  });

  const binding = await createCallSession({
    workspaceId: scope.workspaceId,
    assistantId: assistant.id,
    threadId,
    userId: scope.userId,
    provider: input.provider,
    model: liveModel(),
  });

  return {
    ok: true,
    call: { scope, threadId, instructions, binding },
  };
}

async function resolveThread(
  scope: RequestScope,
  assistantId: string,
  requested: string | null | undefined,
  title: string,
  channel: Channel
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
    channel,
    title,
  });
  return threadId;
}
