import { randomUUID } from "node:crypto";

import { createCommitment } from "../agent/lib/commitments.ts";
import type { EmailConfig, SendResult } from "../agent/lib/email.ts";
import { renderNotification, threadUrl } from "../agent/lib/email-template.ts";
import {
  claimNotifications,
  notificationDedupeKey,
  readJob,
  updateJobWithLease,
  NOTIFICATION_MAX_ATTEMPTS,
  type NotificationEvent,
  type NotificationJob,
} from "../agent/lib/notifications.ts";
import { sendNotification, sweepNotifications } from "../agent/lib/notification-sender.ts";
import { isQuiet, nextSendableTime } from "../agent/lib/quiet-hours.ts";
import { admin, createTestWorkspace, type TestWorkspace } from "./memory-support.mts";

/**
 * Deterministic tests for email notification. No network: the Resend call is a
 * seam, so a timeout, a duplicate and a permanent refusal are stated rather
 * than provoked. The database is real, because the claim, the lease and the
 * tenant constraints are what is under test.
 */

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const CONFIG: EmailConfig = {
  apiKey: "test-key",
  from: "Maya <maya@humanframe.test>",
  enabled: true,
  allowlist: null,
};

function scriptedSender(results: SendResult[]) {
  const calls: { to: string; key: string; subject: string; html: string }[] = [];
  const send = async (input: {
    payload: { to: string; subject: string; html: string };
    idempotencyKey: string;
  }): Promise<SendResult> => {
    calls.push({
      to: input.payload.to,
      key: input.idempotencyKey,
      subject: input.payload.subject,
      html: input.payload.html,
    });
    return results.shift() ?? { kind: "sent", providerMessageId: `msg_${calls.length}` };
  };
  return { send: send as never, calls };
}

async function createThread(workspace: TestWorkspace, title: string): Promise<string> {
  const { data, error } = await admin
    .from("threads")
    .insert({
      workspace_id: workspace.workspaceId,
      assistant_id: workspace.assistantId,
      title,
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`thread insert failed: ${error?.message}`);
  return data.id;
}

async function enableEmail(
  workspace: TestWorkspace,
  patch: Record<string, unknown> = {}
): Promise<void> {
  await admin.from("notification_settings").upsert(
    {
      workspace_id: workspace.workspaceId,
      user_id: workspace.userId,
      email_enabled: true,
      reminders: true,
      background_done: true,
      approval_needed: true,
      ...patch,
    },
    { onConflict: "workspace_id,user_id" }
  );
}

/** Writes a message and its notification through the atomic RPC. */
async function recordMessage(
  workspace: TestWorkspace,
  threadId: string,
  input: {
    sourceMessageId: string;
    createdAt: string;
    sessionId: string;
    turnId: string;
    event?: NotificationEvent;
    subjectType?: "commitment" | "task" | "approval";
    subjectId?: string | null;
  }
): Promise<{ message_id: string; notification_id: string | null }> {
  const dedupeKey = input.event
    ? notificationDedupeKey({
        event: input.event,
        sessionId: input.sessionId,
        turnId: input.turnId,
      })
    : null;

  const { data, error } = await admin.rpc("record_assistant_message", {
    p_workspace_id: workspace.workspaceId,
    p_assistant_id: workspace.assistantId,
    p_thread_id: threadId,
    p_role: "assistant",
    p_channel: "chat",
    p_content: [{ type: "text", text: "Done." }],
    p_source_message_id: input.sourceMessageId,
    p_created_at: input.createdAt,
    p_eve_session_id: input.sessionId,
    p_eve_turn_id: input.turnId,
    p_notify_user_id: input.event ? workspace.userId : null,
    p_event_type: input.event ?? null,
    p_dedupe_key: dedupeKey,
    p_subject_type: input.subjectType ?? null,
    p_subject_id: input.subjectId ?? null,
  });
  if (error) throw new Error(`record_assistant_message failed: ${error.message}`);
  return (data as { message_id: string; notification_id: string | null }[])[0];
}

async function jobFor(dedupeKey: string): Promise<NotificationJob | null> {
  const { data } = await admin
    .from("notification_outbox")
    .select("id")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle<{ id: string }>();
  return data ? readJob(admin, data.id) : null;
}

async function main(): Promise<void> {
  const alpha = await createTestWorkspace("notify-a");
  const beta = await createTestWorkspace("notify-b");

  try {
    const thread = await createThread(alpha, "Notifications");
    const betaThread = await createThread(beta, "Other tenant");
    await enableEmail(alpha);

    // --- 1. Quiet hours, including DST ------------------------------------
    {
      const quiet = { start: "22:00", end: "07:00", timeZone: "Europe/Oslo" };
      // 23:30 Oslo in January (UTC+1) is 22:30 UTC.
      check("a wrapping quiet window is quiet at night",
        isQuiet(new Date("2026-01-15T22:30:00Z"), quiet));
      // 12:00 Oslo is not.
      check("it is not quiet at midday",
        !isQuiet(new Date("2026-01-15T11:00:00Z"), quiet));

      // The same wall-clock instant in UTC lands either side of 22:00 local
      // depending on the season: 20:30 UTC is 21:30 in Oslo in January and
      // 22:30 in July. Anything computing with a fixed offset gets one of
      // these two backwards.
      check("quiet hours follow the zone across DST, not a fixed offset",
        !isQuiet(new Date("2026-01-15T20:30:00Z"), quiet) &&
          isQuiet(new Date("2026-07-15T20:30:00Z"), quiet),
        {
          january: isQuiet(new Date("2026-01-15T20:30:00Z"), quiet),
          july: isQuiet(new Date("2026-07-15T20:30:00Z"), quiet),
        });

      const held = nextSendableTime(new Date("2026-01-15T23:00:00Z"), quiet);
      const local = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Oslo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(held);
      check("a held notification is released when quiet hours end", local === "07:00",
        { local });

      // The night the clocks go forward in Europe/Oslo: 02:00 -> 03:00 local.
      const dstNight = nextSendableTime(new Date("2026-03-29T00:30:00Z"), quiet);
      const dstLocal = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Oslo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(dstNight);
      check("release time is correct on the night the clocks change",
        dstLocal === "07:00", { dstLocal });

      const none = { start: null, end: null, timeZone: "Europe/Oslo" };
      check("no quiet hours configured is never quiet",
        !isQuiet(new Date(), none));
    }

    // --- 2. Idempotent creation --------------------------------------------
    {
      const sessionId = `ses_${randomUUID()}`;
      const turnId = `turn_${randomUUID()}`;
      const at = new Date().toISOString();
      const first = await recordMessage(alpha, thread, {
        sourceMessageId: `evt_${randomUUID()}`,
        createdAt: at,
        sessionId,
        turnId,
        event: "reminder",
      });
      // The same hook event, replayed verbatim.
      const second = await recordMessage(alpha, thread, {
        sourceMessageId: `evt_replay`,
        createdAt: at,
        sessionId,
        turnId,
        event: "reminder",
      });

      check("the message is written", Boolean(first.message_id));
      check("a notification job is created with it", Boolean(first.notification_id));
      check("a replayed hook creates exactly one notification",
        second.notification_id === first.notification_id,
        { first: first.notification_id, second: second.notification_id });

      const { count } = await admin
        .from("notification_outbox")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", alpha.workspaceId)
        .eq("dedupe_key", notificationDedupeKey({ event: "reminder", sessionId, turnId }));
      check("there is one row, not two", count === 1, { count });
    }

    // --- 3. A message with no notification ---------------------------------
    {
      const result = await recordMessage(alpha, thread, {
        sourceMessageId: `evt_${randomUUID()}`,
        createdAt: new Date().toISOString(),
        sessionId: `ses_${randomUUID()}`,
        turnId: `turn_${randomUUID()}`,
      });
      check("an ordinary message produces no notification",
        result.notification_id === null && Boolean(result.message_id));
    }

    // --- 4. Concurrent claims ----------------------------------------------
    {
      const sessionId = `ses_${randomUUID()}`;
      const turnId = `turn_${randomUUID()}`;
      await recordMessage(alpha, thread, {
        sourceMessageId: `evt_${randomUUID()}`,
        createdAt: new Date().toISOString(),
        sessionId,
        turnId,
        event: "reminder",
      });
      const key = notificationDedupeKey({ event: "reminder", sessionId, turnId });
      const job = (await jobFor(key))!;

      const claims = await Promise.all([
        claimNotifications(admin, { id: job.id }),
        claimNotifications(admin, { id: job.id }),
      ]);
      check("a job is claimed by exactly one worker", claims.flat().length === 1,
        { claims: claims.flat().length });
    }

    // --- 5. Expired lease is recoverable ------------------------------------
    {
      const key = await seedJob(alpha, thread, "reminder");
      const job = (await jobFor(key))!;
      const [claimed] = await claimNotifications(admin, { id: job.id, leaseMs: 60_000 });
      check("the first claim wins", claimed?.id === job.id);
      check("a live lease blocks a second claim",
        (await claimNotifications(admin, { id: job.id })).length === 0);

      await admin
        .from("notification_outbox")
        .update({ lease_until: new Date(Date.now() - 1000).toISOString() })
        .eq("id", job.id);
      const [recovered] = await claimNotifications(admin, { id: job.id });
      check("a job stranded in sending is recovered when its lease expires",
        recovered?.id === job.id);
      check("the attempt count carries the retry, not the identity",
        recovered!.attempt_count === 2, { attempts: recovered?.attempt_count });

      const stale = await updateJobWithLease(admin, recovered!, randomUUID(), {
        status: "sent",
      });
      check("a write with a stale lease token does nothing", stale === false);
    }

    // --- 6. Crash before sending --------------------------------------------
    {
      const key = await seedJob(alpha, thread, "reminder");
      const job = (await jobFor(key))!;
      // A worker claimed it and died before calling Resend.
      await claimNotifications(admin, { id: job.id, leaseMs: 1 });
      await admin
        .from("notification_outbox")
        .update({ lease_until: new Date(Date.now() - 1000).toISOString() })
        .eq("id", job.id);

      const sender = scriptedSender([{ kind: "sent", providerMessageId: "msg_after_crash" }]);
      const outcome = await sendNotification(job.id, {
        client: admin, config: CONFIG, send: sender.send, appOrigin: "https://app.test",
      });
      check("a crash before sending is retried and delivered",
        outcome.status === "sent", outcome);
      check("exactly one email is sent", sender.calls.length === 1);
      const after = await readJob(admin, job.id);
      check("the provider id is recorded",
        after?.provider_message_id === "msg_after_crash", after?.provider_message_id);
    }

    // --- 7. Timeout after a possible send ------------------------------------
    {
      const key = await seedJob(alpha, thread, "reminder");
      const job = (await jobFor(key))!;
      const sender = scriptedSender([{ kind: "unknown", error: new Error("socket hang up") }]);
      const outcome = await sendNotification(job.id, {
        client: admin, config: CONFIG, send: sender.send, appOrigin: "https://app.test",
      });
      check("an unknown outcome defers rather than failing",
        outcome.status === "deferred" && outcome.reason === "unknown", outcome);

      const after = await readJob(admin, job.id);
      check("the job is pending again, not failed", after?.status === "pending",
        { status: after?.status });
      check("it is not retried immediately",
        new Date(after!.available_at).getTime() > Date.now(), after?.available_at);

      // The retry carries the same idempotency key, which is what makes
      // Resend's 24-hour window collapse it if the first one did arrive.
      await admin
        .from("notification_outbox")
        .update({ available_at: new Date(Date.now() - 1000).toISOString() })
        .eq("id", job.id);
      const retry = scriptedSender([{ kind: "duplicate", providerMessageId: "msg_original" }]);
      const second = await sendNotification(job.id, {
        client: admin, config: CONFIG, send: retry.send, appOrigin: "https://app.test",
      });
      check("a retry uses the same idempotency key",
        retry.calls[0]?.key === `humanframe-notification/${job.id}`, retry.calls[0]?.key);
      check("a provider-side duplicate counts as sent, not as a second email",
        second.status === "sent", second);
    }

    // --- 8. Retry, then permanent failure -------------------------------------
    {
      const key = await seedJob(alpha, thread, "reminder");
      const job = (await jobFor(key))!;
      const sender = scriptedSender([{ kind: "refused", status: 422, error: { message: "bad address" } }]);
      const outcome = await sendNotification(job.id, {
        client: admin, config: CONFIG, send: sender.send, appOrigin: "https://app.test",
      });
      check("a refusal fails permanently instead of retrying",
        outcome.status === "failed", outcome);
      const after = await readJob(admin, job.id);
      check("the job is marked failed", after?.status === "failed");

      // And an exhausted retry budget also lands as failed, not as silence.
      const exhaustedKey = await seedJob(alpha, thread, "reminder");
      const exhausted = (await jobFor(exhaustedKey))!;
      await admin
        .from("notification_outbox")
        .update({ attempt_count: NOTIFICATION_MAX_ATTEMPTS })
        .eq("id", exhausted.id);
      const retrying = scriptedSender([{ kind: "retry", status: 429, error: { message: "slow down" } }]);
      const last = await sendNotification(exhausted.id, {
        client: admin, config: CONFIG, send: retrying.send, appOrigin: "https://app.test",
      });
      check("an exhausted job fails rather than retrying forever",
        last.status === "failed" && last.reason === "max_attempts", last);
    }

    // --- 9. Disabled notifications ---------------------------------------------
    {
      await enableEmail(alpha, { email_enabled: false });
      const key = await seedJob(alpha, thread, "reminder");
      const job = (await jobFor(key))!;
      const sender = scriptedSender([]);
      const outcome = await sendNotification(job.id, {
        client: admin, config: CONFIG, send: sender.send, appOrigin: "https://app.test",
      });
      check("nothing is sent when email is off",
        outcome.status === "skipped" && outcome.reason === "disabled", outcome);
      check("the provider is never called", sender.calls.length === 0);

      await enableEmail(alpha, { email_enabled: true, reminders: false });
      const perTypeKey = await seedJob(alpha, thread, "reminder");
      const perType = (await jobFor(perTypeKey))!;
      const outcome2 = await sendNotification(perType.id, {
        client: admin, config: CONFIG, send: sender.send, appOrigin: "https://app.test",
      });
      check("a single disabled event type is respected",
        outcome2.status === "skipped", outcome2);
      await enableEmail(alpha);
    }

    // --- 10. Cancelled commitment, resolved approval ----------------------------
    {
      const commitment = await createCommitment(
        { client: admin, workspaceId: alpha.workspaceId, assistantId: alpha.assistantId },
        {
          threadId: thread,
          title: "cancelled before the email",
          dueAt: new Date().toISOString(),
          dueTimezone: "Europe/Oslo",
          dedupeKey: `notify-cancel-${randomUUID()}`,
        }
      );
      const key = await seedJob(alpha, thread, "reminder", {
        subjectType: "commitment",
        subjectId: commitment.id,
      });
      await admin.from("commitments").update({ status: "cancelled" }).eq("id", commitment.id);

      const sender = scriptedSender([]);
      const job = (await jobFor(key))!;
      const outcome = await sendNotification(job.id, {
        client: admin, config: CONFIG, send: sender.send, appOrigin: "https://app.test",
      });
      check("a cancelled commitment is not emailed about",
        outcome.status === "skipped" && outcome.reason === "commitment_cancelled", outcome);
      check("no email is sent for it", sender.calls.length === 0);
    }

    // --- 11. Sending disabled by environment, and the allowlist -----------------
    {
      const key = await seedJob(alpha, thread, "reminder");
      const job = (await jobFor(key))!;
      const sender = scriptedSender([]);
      const off = await sendNotification(job.id, {
        client: admin,
        config: { ...CONFIG, enabled: false },
        send: sender.send,
        appOrigin: "https://app.test",
      });
      check("an environment with sending disabled sends nothing",
        off.status === "skipped" && off.reason === "sending_disabled", off);

      const blockedKey = await seedJob(alpha, thread, "reminder");
      const blocked = (await jobFor(blockedKey))!;
      const outcome = await sendNotification(blocked.id, {
        client: admin,
        config: { ...CONFIG, allowlist: ["someone-else@humanframe.test"] },
        send: sender.send,
        appOrigin: "https://app.test",
      });
      check("an address outside the allowlist is never written to",
        outcome.status === "skipped" && outcome.reason === "not_on_allowlist", outcome);
      check("the provider is not called at all", sender.calls.length === 0);
    }

    // --- 12. The email itself ---------------------------------------------------
    {
      const rendered = renderNotification({
        event: "approval_needed",
        title: 'Send invoice to <script>alert("x")</script> Acme',
        threadUrl: threadUrl("https://app.test/", thread),
        settingsUrl: "https://app.test/settings/notifications",
      });
      check("the subject says what happened without the content",
        rendered.subject === "Maya needs your approval", rendered.subject);
      check("the title is escaped, not injected",
        !rendered.html.includes("<script>"));
      check("the link uses Humanframe's own thread id",
        rendered.html.includes(`?t=${thread}`));
      check("the link uses the configured origin, not a request header",
        rendered.html.includes("https://app.test/assistants/maya"));
      check("there is a settings link", rendered.html.includes("/settings/notifications"));
      check("the plain-text part carries the same link",
        rendered.text.includes(thread));
    }

    // --- 13. Tenant isolation ----------------------------------------------------
    {
      const cross = await admin.from("notification_outbox").insert({
        workspace_id: alpha.workspaceId,
        assistant_id: alpha.assistantId,
        recipient_user_id: alpha.userId,
        thread_id: betaThread,                 // another workspace's thread
        event_type: "reminder",
        dedupe_key: `cross-${randomUUID()}`,
      });
      check("service role cannot target another workspace's thread",
        cross.error !== null, cross.error?.code);

      const crossAssistant = await admin.from("notification_outbox").insert({
        workspace_id: alpha.workspaceId,
        assistant_id: beta.assistantId,        // another workspace's assistant
        recipient_user_id: alpha.userId,
        thread_id: thread,
        event_type: "reminder",
        dedupe_key: `cross-a-${randomUUID()}`,
      });
      check("service role cannot target another workspace's assistant",
        crossAssistant.error !== null, crossAssistant.error?.code);

      const key = await seedJob(alpha, thread, "reminder");
      const job = (await jobFor(key))!;

      const { data: leaked } = await beta.userClient
        .from("notification_outbox")
        .select("id")
        .eq("id", job.id);
      check("another tenant cannot read a notification", (leaked ?? []).length === 0);

      const { data: own } = await alpha.userClient
        .from("notification_outbox")
        .select("id")
        .eq("id", job.id);
      check("the recipient can read their own", (own ?? []).length === 1);

      const forged = await alpha.userClient.from("notification_outbox").insert({
        workspace_id: alpha.workspaceId,
        assistant_id: alpha.assistantId,
        recipient_user_id: alpha.userId,
        thread_id: thread,
        event_type: "reminder",
        dedupe_key: `forged-${randomUUID()}`,
      });
      check("a browser client cannot create a sendable job", forged.error !== null,
        forged.error?.code);

      const { data: tampered } = await alpha.userClient
        .from("notification_outbox")
        .update({ status: "sent" })
        .eq("id", job.id)
        .select("id");
      check("a browser client cannot change delivery status",
        (tampered ?? []).length === 0);

      const { error: rpcError } = await alpha.userClient.rpc("claim_notifications", {
        p_limit: 5, p_lease_ms: 60_000, p_id: job.id,
      });
      check("the claim is not callable from the browser", rpcError !== null,
        rpcError?.code);

      const { error: writeError } = await beta.userClient
        .from("notification_settings")
        .insert({
          workspace_id: alpha.workspaceId,
          user_id: alpha.userId,
          email_enabled: true,
        });
      check("nobody can write another person's notification settings",
        writeError !== null, writeError?.code);
    }

    // --- 14. The sweep is the same path ------------------------------------------
    {
      const key = await seedJob(alpha, thread, "background_done");
      const sender = scriptedSender([{ kind: "sent", providerMessageId: "msg_sweep" }]);
      const outcomes = await sweepNotifications({
        client: admin, config: CONFIG, send: sender.send, appOrigin: "https://app.test",
        limit: 50,
      });
      const mine = outcomes.filter((outcome) => outcome.status === "sent");
      check("the heartbeat sweep sends what the immediate run did not",
        mine.length >= 1, { outcomes: outcomes.length });
      const job = await jobFor(key);
      check("the swept job is marked sent", job?.status === "sent", { status: job?.status });
    }
  } finally {
    await alpha.remove();
    await beta.remove();
  }

  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

/** A notification job with no message behind it, for the delivery tests. */
async function seedJob(
  workspace: TestWorkspace,
  threadId: string,
  event: NotificationEvent,
  subject: { subjectType?: "commitment" | "task" | "approval"; subjectId?: string } = {}
): Promise<string> {
  const dedupeKey = `${event}:${randomUUID()}`;
  const { error } = await admin.from("notification_outbox").insert({
    workspace_id: workspace.workspaceId,
    assistant_id: workspace.assistantId,
    recipient_user_id: workspace.userId,
    thread_id: threadId,
    event_type: event,
    subject_type: subject.subjectType ?? null,
    subject_id: subject.subjectId ?? null,
    dedupe_key: dedupeKey,
  });
  if (error) throw new Error(`seedJob failed: ${error.message}`);
  return dedupeKey;
}

await main();
