import { generateText } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { memoryModel } from "./models";
import { notificationSender } from "./notification-workflow";
import type { MemoryScope } from "./memory-store";

/**
 * Background work, and how it tells the user it is done.
 *
 * The task row is the record; the notification is enqueued in the same place
 * the task is completed, keyed on the task, so a replayed step produces one job
 * rather than one per attempt.
 */

export type TaskRecord = {
  id: string;
  workspace_id: string;
  status: string;
  title: string;
};

export async function openTask(
  scope: MemoryScope,
  input: {
    threadId: string;
    title: string;
    instructions: string;
    idempotencyKey: string;
    eveSessionId: string;
    eveCallId: string;
  }
): Promise<TaskRecord> {
  const { data, error } = await scope.client
    .from("tasks")
    .upsert(
      {
        workspace_id: scope.workspaceId,
        assistant_id: scope.assistantId,
        thread_id: input.threadId,
        title: input.title,
        input: { instructions: input.instructions },
        status: "running",
        started_at: new Date().toISOString(),
        eve_session_id: input.eveSessionId,
        eve_call_id: input.eveCallId,
        idempotency_key: input.idempotencyKey,
      },
      { onConflict: "workspace_id,idempotency_key" }
    )
    .select("id, workspace_id, status, title")
    .single<TaskRecord>();

  if (error || !data) {
    throw new Error(`openTask failed: ${error?.message ?? "no row"}`);
  }
  return data;
}

/** The work itself. One model call, on the memory model rather than Maya's. */
export async function performTask(input: {
  title: string;
  instructions: string;
}): Promise<string> {
  const { text } = await generateText({
    model: memoryModel(),
    system:
      "You are completing a piece of work a colleague started and stepped away " +
      "from. Produce the finished result, not a plan for it. Be concise and " +
      "concrete. If the instructions do not contain enough to finish, say what " +
      "is missing in one sentence.",
    prompt: `Task: ${input.title}\n\n${input.instructions}`,
  });
  return text;
}

export async function completeTask(
  client: SupabaseClient,
  input: {
    taskId: string;
    workspaceId: string;
    assistantId: string;
    threadId: string;
    recipientUserId: string;
    result: string;
  }
): Promise<{ notificationId: string | null }> {
  await client
    .from("tasks")
    .update({
      status: "succeeded",
      result: { text: input.result },
      ended_at: new Date().toISOString(),
    })
    .eq("id", input.taskId);

  const { data } = await client
    .from("notification_outbox")
    .upsert(
      {
        workspace_id: input.workspaceId,
        assistant_id: input.assistantId,
        recipient_user_id: input.recipientUserId,
        thread_id: input.threadId,
        event_type: "background_done",
        subject_type: "task",
        subject_id: input.taskId,
        dedupe_key: `background_done:task:${input.taskId}`,
      },
      { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true }
    )
    .select("id")
    .maybeSingle<{ id: string }>();

  return { notificationId: data?.id ?? null };
}

export async function failTask(
  client: SupabaseClient,
  taskId: string,
  error: unknown
): Promise<void> {
  await client
    .from("tasks")
    .update({
      status: "failed",
      error: { message: error instanceof Error ? error.message : String(error) },
      ended_at: new Date().toISOString(),
    })
    .eq("id", taskId);
}

/** Starts the notification's own run, once its row is committed. */
export async function startNotification(jobId: string): Promise<void> {
  try {
    const { start } = await import("workflow/api");
    await start(notificationSender, [{ jobId }]);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "notification.start_failed",
        jobId,
        error: error instanceof Error ? error.message : String(error),
        note: "the daily heartbeat will send this, up to ~24h later",
      })
    );
  }
}
