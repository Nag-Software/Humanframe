import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isAllowedRecipient,
  readEmailConfig,
  sendEmail,
  type EmailConfig,
  type SendResult,
} from "./email";
import { renderNotification, settingsUrl, threadUrl } from "./email-template";
import {
  claimNotifications,
  deferJob,
  freezePayload,
  markFailed,
  markNeedsReview,
  markSent,
  markSkipped,
  notificationBackoffSeconds,
  readSettings,
  wantsEvent,
  withinDedupeWindow,
  NOTIFICATION_MAX_ATTEMPTS,
  type FrozenPayload,
  type NotificationJob,
} from "./notifications";
import { isQuiet, nextSendableTime } from "./quiet-hours";
import { getRuntimeSupabase } from "./supabase";

/**
 * Sending a notification.
 *
 * The order is deliberate. Everything that can make the email unnecessary is
 * checked *after* the claim and *before* the send, so a reminder cancelled
 * while the job waited, or an approval someone already granted, costs an inbox
 * nothing. Quiet hours defer rather than drop. Only then is anything sent.
 */

export const SEND_TIMEOUT_MS = 20_000;

export type SendOutcome =
  | { status: "sent"; jobId: string }
  | { status: "skipped"; jobId: string; reason: string }
  | { status: "deferred"; jobId: string; reason: string }
  | { status: "failed"; jobId: string; reason: string }
  | { status: "needs_review"; jobId: string; reason: string }
  | { status: "no_work" };

export type Deps = {
  client?: SupabaseClient;
  config?: EmailConfig | null;
  send?: typeof sendEmail;
  now?: Date;
  appOrigin?: string;
};

export async function sendNotification(
  jobId: string,
  deps: Deps = {}
): Promise<SendOutcome> {
  const client = deps.client ?? getRuntimeSupabase();
  if (!client) {
    return { status: "no_work" };
  }

  const [claimed] = await claimNotifications(client, { id: jobId, limit: 1 });
  if (!claimed) {
    // Already sent, already skipped, or held by another worker. All three mean
    // this call has nothing to do.
    return { status: "no_work" };
  }
  return deliver(client, claimed, deps);
}

/** Everything due and unleased. The heartbeat's entry point. */
export async function sweepNotifications(
  deps: Deps & { limit?: number } = {}
): Promise<SendOutcome[]> {
  const client = deps.client ?? getRuntimeSupabase();
  if (!client) {
    return [];
  }

  const jobs = await claimNotifications(client, { limit: deps.limit ?? 25 });
  const outcomes: SendOutcome[] = [];
  for (const job of jobs) {
    try {
      outcomes.push(await deliver(client, job, deps));
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "notification.sweep_failed",
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
  return outcomes;
}

async function deliver(
  client: SupabaseClient,
  job: NotificationJob,
  deps: Deps
): Promise<SendOutcome> {
  const lease = job.lease_token!;
  const now = deps.now ?? new Date();

  // 1. Is this still worth telling anyone about?
  const relevance = await stillRelevant(client, job);
  if (!relevance.relevant) {
    await markSkipped(client, job, lease, relevance.reason);
    return { status: "skipped", jobId: job.id, reason: relevance.reason };
  }

  // 2. Does the recipient want it? Email is opt-in, so no row means no email.
  const settings = await readSettings(client, job.workspace_id, job.recipient_user_id);
  if (!settings || !wantsEvent(settings, job.event_type)) {
    await markSkipped(client, job, lease, "disabled");
    return { status: "skipped", jobId: job.id, reason: "disabled" };
  }

  // 3. Quiet hours delay; they never drop.
  const zone = settings.timezone ?? (await membershipTimezone(client, job)) ?? "UTC";
  const quiet = {
    start: settings.quiet_hours_start,
    end: settings.quiet_hours_end,
    timeZone: zone,
  };
  if (isQuiet(now, quiet)) {
    const until = nextSendableTime(now, quiet);
    await deferJob(client, job, lease, until);
    return { status: "deferred", jobId: job.id, reason: "quiet_hours" };
  }

  // 4. The address is the verified user's, read here. It never arrives as an
  //    argument, so nothing the model writes can redirect an email.
  const address = await recipientAddress(client, job.recipient_user_id);
  if (!address) {
    await markSkipped(client, job, lease, "no_address");
    return { status: "skipped", jobId: job.id, reason: "no_address" };
  }

  const config = deps.config !== undefined ? deps.config : readEmailConfig();
  if (!config || !config.enabled) {
    await markSkipped(client, job, lease, "sending_disabled");
    return { status: "skipped", jobId: job.id, reason: "sending_disabled" };
  }
  if (!isAllowedRecipient(config, address)) {
    await markSkipped(client, job, lease, "not_on_allowlist");
    return { status: "skipped", jobId: job.id, reason: "not_on_allowlist" };
  }

  const origin = deps.appOrigin ?? process.env.APP_URL ?? null;
  if (!origin) {
    await deferJob(client, job, lease, new Date(now.getTime() + 3_600_000), {
      reason: "no_app_origin",
    });
    return { status: "deferred", jobId: job.id, reason: "no_app_origin" };
  }

  // 5. An ambiguous attempt past the provider's window cannot be retried on a
  //    guess: Resend can no longer tell us whether the first one arrived, so
  //    sending again risks a second email and dropping it risks silence.
  if (job.last_outcome === "unknown" && !withinDedupeWindow(job, now)) {
    await markNeedsReview(client, job, lease, "unknown_outcome_past_dedupe_window");
    return {
      status: "needs_review",
      jobId: job.id,
      reason: "unknown_outcome_past_dedupe_window",
    };
  }

  // 6. The body is built once and replayed verbatim. Resend refuses a key
  //    reused with a modified body, and everything here can drift between
  //    attempts: the address, the commitment's title, the configured sender.
  let payload = job.frozen_payload;
  if (!payload) {
    const rendered = renderNotification({
      event: job.event_type,
      title: relevance.title,
      threadUrl: threadUrl(origin, job.thread_id),
      settingsUrl: settingsUrl(origin),
    });
    payload = {
      to: address,
      from: config.from,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    } satisfies FrozenPayload;

    // Frozen before the send, so a crash cannot leave a job whose retry would
    // construct something different.
    await freezePayload(client, job, lease, payload, now);
  } else if (!isAllowedRecipient(config, payload.to)) {
    // The frozen recipient is authoritative, and it is checked again: an
    // allowlist that tightened between attempts must still be obeyed.
    await markSkipped(client, job, lease, "not_on_allowlist");
    return { status: "skipped", jobId: job.id, reason: "not_on_allowlist" };
  }

  const send = deps.send ?? sendEmail;
  const result: SendResult = await send({
    config: { ...config, from: payload.from },
    payload: {
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    },
    // Stable for the life of the job, and always paired with the frozen body,
    // which is what makes Resend's 24-hour window deduplicate our retries.
    idempotencyKey: `humanframe-notification/${job.id}`,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  return record(client, job, lease, result, now);
}

async function record(
  client: SupabaseClient,
  job: NotificationJob,
  lease: string,
  result: SendResult,
  now: Date
): Promise<SendOutcome> {
  if (result.kind === "sent" || result.kind === "duplicate") {
    await markSent(client, job, lease, result.providerMessageId, result.kind);
    return { status: "sent", jobId: job.id };
  }

  if (result.kind === "refused") {
    // A refusal is definitive: a bad address or a key reused with different
    // content will not get better by trying again.
    await markFailed(client, job, lease, result.error);
    return { status: "failed", jobId: job.id, reason: `refused_${result.status}` };
  }

  if (job.attempt_count >= NOTIFICATION_MAX_ATTEMPTS) {
    await markFailed(client, job, lease, {
      reason: "max_attempts",
      attempts: job.attempt_count,
      last: result,
    });
    return { status: "failed", jobId: job.id, reason: "max_attempts" };
  }

  // `retry` and `unknown` both come back here, and are treated identically:
  // an unknown outcome is not a failure, and the idempotency key means a retry
  // inside Resend's 24-hour window cannot become a second email.
  const wait = notificationBackoffSeconds(job.attempt_count) * 1000;
  await deferJob(
    client,
    job,
    lease,
    new Date(now.getTime() + wait),
    result.error,
    result.kind
  );
  return { status: "deferred", jobId: job.id, reason: result.kind };
}

type Relevance = { relevant: true; title: string } | { relevant: false; reason: string };

/**
 * Has the world moved on? A reminder for a commitment the user cancelled, or an
 * approval someone already answered, is not worth an email.
 */
async function stillRelevant(
  client: SupabaseClient,
  job: NotificationJob
): Promise<Relevance> {
  if (job.subject_type === "commitment" && job.subject_id) {
    const { data } = await client
      .from("commitments")
      .select("title, status")
      .eq("id", job.subject_id)
      .maybeSingle<{ title: string; status: string }>();
    if (!data) {
      return { relevant: false, reason: "commitment_missing" };
    }
    if (data.status === "cancelled" || data.status === "done") {
      return { relevant: false, reason: `commitment_${data.status}` };
    }
    return { relevant: true, title: data.title };
  }

  if (job.subject_type === "approval" && job.subject_id) {
    const { data } = await client
      .from("tool_calls")
      .select("tool_name, status")
      .eq("id", job.subject_id)
      .maybeSingle<{ tool_name: string; status: string }>();
    if (!data) {
      return { relevant: false, reason: "approval_missing" };
    }
    if (data.status !== "awaiting_approval") {
      return { relevant: false, reason: `approval_${data.status}` };
    }
    return { relevant: true, title: `Waiting on: ${data.tool_name}` };
  }

  if (job.subject_type === "task" && job.subject_id) {
    const { data } = await client
      .from("tasks")
      .select("title, status")
      .eq("id", job.subject_id)
      .maybeSingle<{ title: string; status: string }>();
    if (!data) {
      return { relevant: false, reason: "task_missing" };
    }
    if (data.status === "cancelled") {
      return { relevant: false, reason: "task_cancelled" };
    }
    return { relevant: true, title: data.title };
  }

  return { relevant: true, title: "Maya has an update for you." };
}

async function membershipTimezone(
  client: SupabaseClient,
  job: NotificationJob
): Promise<string | null> {
  const { data } = await client
    .from("workspace_members")
    .select("timezone")
    .eq("workspace_id", job.workspace_id)
    .eq("user_id", job.recipient_user_id)
    .maybeSingle<{ timezone: string | null }>();
  return data?.timezone ?? null;
}

async function recipientAddress(
  client: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data } = await client
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle<{ email: string | null }>();
  return data?.email ?? null;
}
