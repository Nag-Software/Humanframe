import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The commitment store.
 *
 * Two invariants live here, and every caller depends on them:
 *
 *  1. A wake is claimed, never polled. `claimDueCommitments` is the only way
 *     to start one, and it is atomic: overlapping heartbeat ticks cannot claim
 *     the same row, and a row stranded in `waking` by a crashed worker returns
 *     to the pool when its lease expires.
 *  2. Every state change that belongs to a wake is lease-checked. A worker
 *     that lost its lease writes nothing and stops, silently.
 */

export const DEFAULT_LEASE_MS = 5 * 60_000;
export const WAKE_MAX_ATTEMPTS = 5;
/** Exponential-ish backoff between delivery attempts, in seconds. */
export const WAKE_BACKOFF_SECONDS = [60, 120, 300, 900, 3600];

export type CommitmentStatus =
  | "scheduled"
  | "waking"
  | "delivered"
  | "in_progress"
  | "waiting_approval"
  | "done"
  | "cancelled"
  | "failed";

export type Commitment = {
  id: string;
  workspace_id: string;
  assistant_id: string;
  user_id: string | null;
  goal_id: string | null;
  thread_id: string;
  title: string;
  detail: string | null;
  kind: "follow_up" | "remind" | "deliver";
  owner: "user" | "assistant";
  due_at: string;
  due_timezone: string;
  status: CommitmentStatus;
  wake_seq: number;
  lease_token: string | null;
  lease_until: string | null;
  last_error: unknown;
  dedupe_key: string;
  completed_at: string | null;
  cancelled_at: string | null;
};

export type Delivery = {
  id: string;
  workspace_id: string;
  commitment_id: string;
  wake_seq: number;
  state: "pending" | "sent" | "confirmed" | "abandoned";
  attempts: number;
  next_attempt_at: string | null;
  target_session_id: string | null;
  target_kind: "existing_session" | "new_session" | null;
  marker: string;
  abandoned_reason: string | null;
};

export type CommitmentScope = {
  client: SupabaseClient;
  workspaceId: string;
  assistantId: string;
};

const COMMITMENT_COLUMNS =
  "id, workspace_id, assistant_id, user_id, goal_id, thread_id, title, detail, " +
  "kind, owner, due_at, due_timezone, status, wake_seq, lease_token, " +
  "lease_until, last_error, dedupe_key, completed_at, cancelled_at";

const DELIVERY_COLUMNS =
  "id, workspace_id, commitment_id, wake_seq, state, attempts, " +
  "next_attempt_at, target_session_id, target_kind, marker, abandoned_reason";

/** The token a wake message carries so a retry can recognise its own work. */
export function deliveryMarker(deliveryId: string): string {
  return `[humanframe:delivery:${deliveryId}]`;
}

/** Statuses a wake must not act on. */
export function isTerminal(status: CommitmentStatus): boolean {
  return status === "done" || status === "cancelled" || status === "failed";
}

export function backoffSeconds(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), WAKE_BACKOFF_SECONDS.length) - 1;
  return WAKE_BACKOFF_SECONDS[index];
}

export async function createCommitment(
  scope: CommitmentScope,
  input: {
    threadId: string;
    title: string;
    detail?: string | null;
    dueAt: string;
    dueTimezone: string;
    kind?: Commitment["kind"];
    owner?: Commitment["owner"];
    userId?: string | null;
    goalId?: string | null;
    sourceThreadId?: string | null;
    sourceMessageId?: string | null;
    /** Replay-stable: the tool call id, so a retried step claims one row. */
    dedupeKey: string;
  }
): Promise<Commitment> {
  const { data, error } = await scope.client
    .from("commitments")
    .upsert(
      {
        workspace_id: scope.workspaceId,
        assistant_id: scope.assistantId,
        user_id: input.userId ?? null,
        goal_id: input.goalId ?? null,
        thread_id: input.threadId,
        title: input.title,
        detail: input.detail ?? null,
        kind: input.kind ?? "follow_up",
        owner: input.owner ?? "assistant",
        due_at: input.dueAt,
        due_timezone: input.dueTimezone,
        source_thread_id: input.sourceThreadId ?? null,
        source_message_id: input.sourceMessageId ?? null,
        dedupe_key: input.dedupeKey,
      },
      { onConflict: "workspace_id,assistant_id,dedupe_key" }
    )
    .select(COMMITMENT_COLUMNS)
    .single<Commitment>();

  if (error || !data) {
    throw new Error(`createCommitment failed: ${error?.message ?? "no row"}`);
  }
  return data;
}

/**
 * The atomic claim. Returns rows now leased to this caller, with the lease
 * token needed for every later write.
 *
 * `id` narrows the claim to one commitment — the precision trigger's entry
 * point — so both wake paths go through exactly this predicate.
 */
export async function claimDueCommitments(
  client: SupabaseClient,
  options: { limit?: number; leaseMs?: number; id?: string } = {}
): Promise<Commitment[]> {
  const { data, error } = await client.rpc("claim_commitments_for_wake", {
    p_limit: options.limit ?? 25,
    p_lease_ms: options.leaseMs ?? DEFAULT_LEASE_MS,
    p_id: options.id ?? null,
  });

  if (error) {
    throw new Error(`claim failed: ${error.message}`);
  }
  return (data ?? []) as Commitment[];
}

export async function readCommitment(
  client: SupabaseClient,
  id: string
): Promise<Commitment | null> {
  const { data } = await client
    .from("commitments")
    .select(COMMITMENT_COLUMNS)
    .eq("id", id)
    .maybeSingle<Commitment>();
  return data ?? null;
}

/**
 * Opens — or re-opens — the delivery for a commitment's current logical
 * reminder. The row id is the delivery id and is stable across every retry;
 * `attempts` carries no identity.
 */
export async function openDelivery(
  client: SupabaseClient,
  commitment: Commitment
): Promise<Delivery> {
  const existing = await client
    .from("commitment_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("commitment_id", commitment.id)
    .eq("wake_seq", commitment.wake_seq)
    .maybeSingle<Delivery>();

  if (existing.data) {
    return existing.data;
  }

  // The marker has to be known before the row exists, so the id is minted here
  // rather than by the database.
  const id = randomUUID();
  const { data, error } = await client
    .from("commitment_deliveries")
    .upsert(
      {
        id,
        workspace_id: commitment.workspace_id,
        commitment_id: commitment.id,
        wake_seq: commitment.wake_seq,
        marker: deliveryMarker(id),
        state: "pending",
      },
      { onConflict: "commitment_id,wake_seq", ignoreDuplicates: true }
    )
    .select(DELIVERY_COLUMNS)
    .maybeSingle<Delivery>();

  if (data) {
    return data;
  }

  // Someone else inserted it between the read and the upsert.
  const raced = await client
    .from("commitment_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("commitment_id", commitment.id)
    .eq("wake_seq", commitment.wake_seq)
    .maybeSingle<Delivery>();

  if (!raced.data) {
    throw new Error(`openDelivery failed: ${error?.message ?? "no row"}`);
  }
  return raced.data;
}

/**
 * Records the intent to send, before the send happens. A crash after this and
 * before the send leaves a `pending` row with a raised attempt count, which is
 * exactly what the retry path expects to find.
 */
export async function beginAttempt(
  client: SupabaseClient,
  delivery: Delivery,
  target: { sessionId: string; kind: "existing_session" | "new_session" },
  now = new Date()
): Promise<Delivery> {
  const attempts = delivery.attempts + 1;
  const { data, error } = await client
    .from("commitment_deliveries")
    .update({
      attempts,
      next_attempt_at: new Date(
        now.getTime() + backoffSeconds(attempts) * 1000
      ).toISOString(),
      target_session_id: target.sessionId,
      target_kind: target.kind,
      state: "pending",
    })
    .eq("id", delivery.id)
    .select(DELIVERY_COLUMNS)
    .single<Delivery>();

  if (error || !data) {
    throw new Error(`beginAttempt failed: ${error?.message ?? "no row"}`);
  }
  return data;
}

export async function markDelivery(
  client: SupabaseClient,
  delivery: Delivery,
  patch: {
    state: Delivery["state"];
    error?: unknown;
    reason?: string;
    at?: Date;
  }
): Promise<void> {
  const at = (patch.at ?? new Date()).toISOString();
  const { error } = await client
    .from("commitment_deliveries")
    .update({
      state: patch.state,
      last_error: patch.error ?? null,
      abandoned_reason: patch.reason ?? null,
      ...(patch.state === "sent" ? { sent_at: at } : {}),
      ...(patch.state === "confirmed" ? { confirmed_at: at } : {}),
    })
    .eq("id", delivery.id);

  if (error) {
    throw new Error(`markDelivery failed: ${error.message}`);
  }
}

/**
 * A lease-checked write. Returns false when another worker owns the lease, and
 * the caller must then stop without writing anything else.
 */
export async function updateWithLease(
  client: SupabaseClient,
  commitment: Commitment,
  leaseToken: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  const { data, error } = await client
    .from("commitments")
    .update(patch)
    .eq("id", commitment.id)
    .eq("lease_token", leaseToken)
    .select("id");

  if (error) {
    throw new Error(`updateWithLease failed: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Hands the row back without consuming its logical reminder.
 *
 * The row stays in `waking` on purpose. `scheduled` would make the next claim
 * treat it as a new logical reminder, incrementing `wake_seq` and therefore
 * minting a second delivery id for the same reminder — which is precisely the
 * identity a retry has to keep. Releasing only drops the lease; the claim's
 * stranded-row branch picks it up again with its delivery intact.
 *
 * Moving a commitment to a genuinely new reminder (a reschedule, a snooze) is
 * a different operation and sets `scheduled` explicitly.
 */
export function releaseLease(
  client: SupabaseClient,
  commitment: Commitment,
  leaseToken: string
): Promise<boolean> {
  return updateWithLease(client, commitment, leaseToken, {
    lease_token: null,
    lease_until: null,
  });
}

/** Opens a new logical reminder: a reschedule, not a retry. */
export async function rescheduleCommitment(
  scope: CommitmentScope,
  id: string,
  dueAt: string
): Promise<boolean> {
  const { data } = await scope.client
    .from("commitments")
    .update({
      due_at: dueAt,
      status: "scheduled",
      lease_token: null,
      lease_until: null,
    })
    .eq("id", id)
    .eq("workspace_id", scope.workspaceId)
    .not("status", "in", '("done","cancelled")')
    .select("id");
  return (data?.length ?? 0) > 0;
}

/** The wake reached the user; the commitment is now Maya's to act on. */
export function markDelivered(
  client: SupabaseClient,
  commitment: Commitment,
  leaseToken: string
): Promise<boolean> {
  return updateWithLease(client, commitment, leaseToken, {
    status: "delivered",
    lease_token: null,
    lease_until: null,
  });
}

/** Every attempt is spent. The miss is recorded, never silently dropped. */
export function markWakeFailed(
  client: SupabaseClient,
  commitment: Commitment,
  leaseToken: string,
  error: unknown
): Promise<boolean> {
  return updateWithLease(client, commitment, leaseToken, {
    status: "failed",
    last_error: error ?? null,
    lease_token: null,
    lease_until: null,
  });
}

/**
 * User-facing transitions. Deliberately not lease-checked: a person cancelling
 * is allowed to win a race with a delivery in flight, and the delivery path
 * re-reads the row before it sends.
 */
export async function cancelCommitment(
  scope: CommitmentScope,
  id: string
): Promise<boolean> {
  const { data } = await scope.client
    .from("commitments")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      lease_token: null,
      lease_until: null,
    })
    .eq("id", id)
    .eq("workspace_id", scope.workspaceId)
    .not("status", "in", '("done","cancelled")')
    .select("id");
  return (data?.length ?? 0) > 0;
}

export async function completeCommitment(
  scope: CommitmentScope,
  id: string
): Promise<boolean> {
  const { data } = await scope.client
    .from("commitments")
    .update({
      status: "done",
      completed_at: new Date().toISOString(),
      lease_token: null,
      lease_until: null,
    })
    .eq("id", id)
    .eq("workspace_id", scope.workspaceId)
    .not("status", "in", '("done","cancelled")')
    .select("id");
  return (data?.length ?? 0) > 0;
}

/**
 * One row per business transition. The deterministic key makes the insert both
 * the record and the decision: the first writer wins and is told so.
 */
export async function recordEvent(
  client: SupabaseClient,
  event: {
    workspaceId: string;
    assistantId?: string | null;
    subjectType: "goal" | "commitment" | "delivery" | "task" | "approval";
    subjectId: string;
    type: string;
    payload?: Record<string, unknown>;
    threadId?: string | null;
    eveSessionId?: string | null;
    idempotencyKey: string;
  }
): Promise<boolean> {
  const { data, error } = await client
    .from("events")
    .upsert(
      {
        workspace_id: event.workspaceId,
        assistant_id: event.assistantId ?? null,
        subject_type: event.subjectType,
        subject_id: event.subjectId,
        type: event.type,
        payload: event.payload ?? {},
        thread_id: event.threadId ?? null,
        eve_session_id: event.eveSessionId ?? null,
        idempotency_key: event.idempotencyKey,
      },
      { onConflict: "workspace_id,idempotency_key", ignoreDuplicates: true }
    )
    .select("id");

  if (error) {
    throw new Error(`recordEvent failed: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}
