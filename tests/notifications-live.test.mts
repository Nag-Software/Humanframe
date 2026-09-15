import { randomUUID } from "node:crypto";

import { readEmailConfig } from "../agent/lib/email.ts";
import { completeTask } from "../agent/lib/background-task.ts";
import { readJob } from "../agent/lib/notifications.ts";
import { sendNotification } from "../agent/lib/notification-sender.ts";
import { threadUrl } from "../agent/lib/email-template.ts";
import { admin, createTestWorkspace } from "./memory-support.mts";
import { loadEnv } from "./harness.mts";

/**
 * Opt-in: sends one real email through Resend.
 *
 * Finished background work → one received email → a link to the right signed-in
 * conversation. It refuses to run unless the environment is explicitly
 * configured to send and a recipient is named, so it can never surprise a real
 * user.
 *
 *   NOTIFICATIONS_ENABLED=true \
 *   NOTIFICATIONS_ALLOWLIST=you@example.com \
 *   NOTIFICATIONS_TEST_RECIPIENT=you@example.com \
 *   RESEND_API_KEY=... APP_URL=https://... pnpm test:live:notifications
 */

async function main(): Promise<void> {
  const env = loadEnv();
  const recipient = env.NOTIFICATIONS_TEST_RECIPIENT;
  const config = readEmailConfig();

  if (!recipient || !config || !config.enabled) {
    console.log(
      "SKIP  live notification test (set RESEND_API_KEY, NOTIFICATIONS_ENABLED=true " +
        "and NOTIFICATIONS_TEST_RECIPIENT to run it)"
    );
    return;
  }
  if (!config.allowlist?.includes(recipient.toLowerCase())) {
    console.log("SKIP  live notification test (recipient is not on NOTIFICATIONS_ALLOWLIST)");
    return;
  }

  const workspace = await createTestWorkspace("notify-live");
  try {
    // The email goes to the workspace's own verified address, so point that at
    // the test recipient rather than passing an address to the sender.
    await admin.from("users").update({ email: recipient }).eq("id", workspace.userId);
    await admin.from("notification_settings").upsert(
      {
        workspace_id: workspace.workspaceId,
        user_id: workspace.userId,
        email_enabled: true,
        background_done: true,
      },
      { onConflict: "workspace_id,user_id" }
    );

    const { data: thread } = await admin
      .from("threads")
      .insert({
        workspace_id: workspace.workspaceId,
        assistant_id: workspace.assistantId,
        title: "Live notification test",
      })
      .select("id")
      .single<{ id: string }>();

    const { data: task } = await admin
      .from("tasks")
      .insert({
        workspace_id: workspace.workspaceId,
        assistant_id: workspace.assistantId,
        thread_id: thread!.id,
        title: "Draft the quarterly summary",
        status: "running",
        idempotency_key: `live-${randomUUID()}`,
      })
      .select("id")
      .single<{ id: string }>();

    const { notificationId } = await completeTask(admin, {
      taskId: task!.id,
      workspaceId: workspace.workspaceId,
      assistantId: workspace.assistantId,
      threadId: thread!.id,
      recipientUserId: workspace.userId,
      result: "The summary is ready in the conversation.",
    });

    if (!notificationId) {
      console.log("FAIL  no notification job was created");
      process.exit(1);
    }

    const outcome = await sendNotification(notificationId, {});
    const job = await readJob(admin, notificationId);

    console.log(`outcome: ${JSON.stringify(outcome)}`);
    console.log(`provider message id: ${job?.provider_message_id ?? "none"}`);
    console.log(
      `the email links to: ${threadUrl(env.APP_URL ?? "http://localhost:3000", thread!.id)}`
    );

    if (outcome.status !== "sent") {
      console.log("FAIL  the notification was not sent");
      process.exit(1);
    }
    console.log(
      "\nPASS  one email sent. Check the inbox, open the link, and confirm it " +
        "lands in that conversation while signed in."
    );
  } finally {
    await workspace.remove();
  }
}

await main();
