import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The notification outbox.
 *
 * Same discipline as the commitment wake: a job is claimed under a lease, the
 * claim recovers rows stranded by a worker that died mid-send, and every state
 * change is checked against the lease so a worker that lost it writes nothing.
 */

export const NOTIFICATION_LEASE_MS = 2 * 60_000;
export const NOTIFICATION_MAX_ATTEMPTS = 5;
/**
 * Backoff between attempts, in seconds. The last value matters: Resend's
 * idempotency keys expire after 24 hours, so an attempt beyond that window
 * would no longer be deduplicated by the provider. The schedule below tops out
 * well inside it.
 */
export const NOTIFICATION_BACKOFF_SECONDS = [60, 300, 900, 3600, 10800];

export type NotificationEvent = "reminder" | "background_done" | "approval_needed";

export type NotificationStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "skipped";

export type NotificationJob = {
  id: string;
  workspace_id: string;
  assistant_id: string;
  recipient_user_id: string;
  thread_id: string;
  source_message_id: string | null;
  event_type: NotificationEvent;
  subject_type: "commitment" | "task" | "approval" | null;
  subject_id: string | null;
  dedupe_key: string;
  status: NotificationStatus;
  available_at: string;
  attempt_count: number;
  lease_token: string | null;
  provider_message_id: string | null;
};

export type NotificationSettings = {
  email_enabled: boolean;
  reminders: boolean;
  background_done: boolean;
  approval_needed: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string | null;
};

const JOB_COLUMNS =
  "id, workspace_id, assistant_id, recipient_user_id, thread_id, " +
  "source_message_id, event_type, subject_type, subject_id, dedupe_key, " +
  "status, available_at, attempt_count, lease_token, provider_message_id";

export function notificationBackoffSeconds(attempt: number): number {
  const index =
    Math.min(Math.max(attempt, 1), NOTIFICATION_BACKOFF_SECONDS.length) - 1;
  return NOTIFICATION_BACKOFF_SECONDS[index];
}

/**
 * The key a notification is remembered by, and the key Resend deduplicates on.
 * Derived from the business event, never from the attempt, so every retry of
 * the same logical notification carries the same key.
 */
export function notificationDedupeKey(input: {
  event: NotificationEvent;
  sessionId: string;
  turnId: string;
}): string {
  return `${input.event}:${input.sessionId}:${input.turnId}`;
}

export async function claimNotifications(
  client: SupabaseClient,
  options: { limit?: number; leaseMs?: number; id?: string } = {}
): Promise<NotificationJob[]> {
  const { data, error } = await client.rpc("claim_notifications", {
    p_limit: options.limit ?? 25,
    p_lease_ms: options.leaseMs ?? NOTIFICATION_LEASE_MS,
    p_id: options.id ?? null,
  });
  if (error) {
    throw new Error(`claim_notifications failed: ${error.message}`);
  }
  return (data ?? []) as NotificationJob[];
}

export async function readJob(
  client: SupabaseClient,
  id: string
): Promise<NotificationJob | null> {
  const { data } = await client
    .from("notification_outbox")
    .select(JOB_COLUMNS)
    .eq("id", id)
    .maybeSingle<NotificationJob>();
  return data ?? null;
}

/** A lease-checked write. False means another worker owns this job now. */
export async function updateJobWithLease(
  client: SupabaseClient,
  job: NotificationJob,
  leaseToken: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  const { data, error } = await client
    .from("notification_outbox")
    .update(patch)
    .eq("id", job.id)
    .eq("lease_token", leaseToken)
    .select("id");
  if (error) {
    throw new Error(`updateJobWithLease failed: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}

export function markSent(
  client: SupabaseClient,
  job: NotificationJob,
  leaseToken: string,
  providerMessageId: string | null
): Promise<boolean> {
  return updateJobWithLease(client, job, leaseToken, {
    status: "sent",
    provider_message_id: providerMessageId,
    sent_at: new Date().toISOString(),
    lease_token: null,
    lease_until: null,
  });
}

export function markSkipped(
  client: SupabaseClient,
  job: NotificationJob,
  leaseToken: string,
  reason: string
): Promise<boolean> {
  return updateJobWithLease(client, job, leaseToken, {
    status: "skipped",
    skipped_reason: reason,
    lease_token: null,
    lease_until: null,
  });
}

export function markFailed(
  client: SupabaseClient,
  job: NotificationJob,
  leaseToken: string,
  error: unknown
): Promise<boolean> {
  return updateJobWithLease(client, job, leaseToken, {
    status: "failed",
    last_error: serialise(error),
    lease_token: null,
    lease_until: null,
  });
}

/** Hands the job back for another attempt at `availableAt`. */
export function deferJob(
  client: SupabaseClient,
  job: NotificationJob,
  leaseToken: string,
  availableAt: Date,
  error?: unknown
): Promise<boolean> {
  return updateJobWithLease(client, job, leaseToken, {
    status: "pending",
    available_at: availableAt.toISOString(),
    last_error: error === undefined ? null : serialise(error),
    lease_token: null,
    lease_until: null,
  });
}

export async function readSettings(
  client: SupabaseClient,
  workspaceId: string,
  userId: string
): Promise<NotificationSettings | null> {
  const { data } = await client
    .from("notification_settings")
    .select(
      "email_enabled, reminders, background_done, approval_needed, " +
        "quiet_hours_start, quiet_hours_end, timezone"
    )
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle<NotificationSettings>();
  return data ?? null;
}

/** Does this event type pass the recipient's own preferences? */
export function wantsEvent(
  settings: NotificationSettings,
  event: NotificationEvent
): boolean {
  if (!settings.email_enabled) {
    return false;
  }
  if (event === "reminder") return settings.reminders;
  if (event === "background_done") return settings.background_done;
  return settings.approval_needed;
}

function serialise(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (typeof error === "object" && error !== null) {
    return error as Record<string, unknown>;
  }
  return { message: String(error) };
}
