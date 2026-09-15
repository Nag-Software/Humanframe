import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import {
  completeTask,
  failTask,
  openTask,
  performTask,
  startNotification,
} from "../lib/background-task";
import { resolveMemoryScope } from "../lib/session-scope";
import { resolveSessionTarget } from "../lib/session-target";
import { getRuntimeSupabase } from "../lib/supabase";

/**
 * Work that outlives the conversation.
 *
 * The call returns a receipt immediately and the run continues on its own, so
 * the user can close the tab. When it finishes, eve wakes this session with the
 * result — and, separately, the user is emailed that it is done. Those are two
 * different channels for the same event and neither depends on the other.
 */
export default defineWorkflowTool({
  description:
    "Start work that should continue after this conversation and report back " +
    "when it is finished. Use it for anything that would take longer than the " +
    "user should sit and wait for. Say what you have started before you stop.",
  inputSchema: z.object({
    title: z.string().min(3).max(200).describe("What this piece of work is"),
    instructions: z
      .string()
      .min(10)
      .max(8000)
      .describe("Everything needed to finish it without asking again"),
  }),
  execution: "background",
  async execute(input, ctx) {
    "use workflow";
    return await runTask({
      title: input.title,
      instructions: input.instructions,
      sessionId: ctx.session.id,
      callId: ctx.callId,
    });
  },
});

async function runTask(input: {
  title: string;
  instructions: string;
  sessionId: string;
  callId: string;
}): Promise<{ completed: boolean; result?: string; note?: string }> {
  "use step";
  const scope = await resolveMemoryScope({
    id: input.sessionId,
    auth: { initiator: null, current: null },
  });
  const client = getRuntimeSupabase();
  if (!scope || !client) {
    return { completed: false, note: "No workspace is attached to this session." };
  }

  const target = await resolveSessionTarget({
    sessionId: input.sessionId,
    userId: scope.userId,
  });
  if (!target) {
    return { completed: false, note: "This conversation is not stored yet." };
  }

  const task = await openTask(scope, {
    threadId: target.threadId,
    title: input.title,
    instructions: input.instructions,
    // Replay-stable, so a retried step continues one task rather than opening
    // a second.
    idempotencyKey: `call:${input.callId}`,
    eveSessionId: input.sessionId,
    eveCallId: input.callId,
  });

  try {
    const result = await performTask(input);
    const { notificationId } = await completeTask(client, {
      taskId: task.id,
      workspaceId: scope.workspaceId,
      assistantId: scope.assistantId,
      threadId: target.threadId,
      recipientUserId: scope.userId,
      result,
    });
    if (notificationId) {
      await startNotification(notificationId);
    }
    return { completed: true, result };
  } catch (error) {
    await failTask(client, task.id, error);
    throw error;
  }
}
