import { buildCallEndedMessage, callDeservesTrace } from "@/agent/lib/call-trace";
import { logger } from "@/lib/logger";
import { getAgentRuntime } from "@/server/agent/runtime/eve-runtime";
import type { CallBinding, EndedCall } from "@/server/call/binding";
import { getThread, linkEveSession } from "@/server/db/repositories/threads";

/**
 * Tells Maya the call ended, so she writes its trace into the conversation.
 *
 * The signal goes into the thread's own eve session — the history the user
 * reads — the same way a delegation does mid-call. Her reply is the chapter.
 * `endCallSession` already made sure this runs once per call; a short call
 * with nothing in it leaves nothing.
 */
export async function traceEndedCall(input: {
  binding: CallBinding;
  ended: EndedCall;
  video: boolean;
  cookie: string | null;
  origin: string | null;
}): Promise<"sent" | "skipped" | "failed"> {
  const { binding, ended } = input;
  if (!callDeservesTrace(ended)) {
    return "skipped";
  }

  const runtime = getAgentRuntime({ cookie: input.cookie, origin: input.origin });
  const scope = {
    client: binding.client,
    workspaceId: binding.workspaceId,
    userId: binding.userId,
  };
  const message = [
    {
      type: "text" as const,
      text: buildCallEndedMessage({
        callSessionId: binding.callSessionId,
        durationMs: ended.durationMs,
        turnCount: ended.turnCount,
        video: input.video,
      }),
    },
  ];

  try {
    const thread = await getThread(scope, binding.threadId);
    if (thread?.eveSessionId) {
      await runtime.continueSession({
        sessionId: thread.eveSessionId,
        message,
        turnPolicy: "queue",
      });
    } else {
      const started = await runtime.startSession({
        workspaceId: binding.workspaceId,
        assistantId: binding.assistantId,
        threadId: binding.threadId,
        channel: "chat",
        message,
      });
      await linkEveSession(scope, binding.threadId, started.sessionId);
    }

    logger.info("call.trace_requested", {
      callSessionId: binding.callSessionId,
      durationMs: ended.durationMs,
      turnCount: ended.turnCount,
    });
    return "sent";
  } catch (error) {
    logger.error("call.trace_failed", {
      callSessionId: binding.callSessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}
