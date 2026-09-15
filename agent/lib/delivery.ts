import type { SupabaseClient } from "@supabase/supabase-js";

import {
  WAKE_MAX_ATTEMPTS,
  beginAttempt,
  isTerminal,
  markDelivered,
  markDelivery,
  markWakeFailed,
  openDelivery,
  readCommitment,
  recordEvent,
  releaseLease,
  type Commitment,
  type Delivery,
} from "./commitments";

/**
 * The delivery protocol.
 *
 * Delivery is at-least-once, and says so. eve's follow-up message route takes
 * no idempotency key — `operationId` is create-only — so the receiver offers no
 * documented deduplication and no exactly-once claim is made here. What this
 * protocol guarantees instead:
 *
 *  - a duplicate is *detectable*: every wake carries its delivery's marker;
 *  - it is *checked for* before any retry, so an ambiguous send (timeout,
 *    reset, crash after the receiver accepted) does not become a second wake;
 *  - it is *harmless* if one still slips through: the wake is a system-channel
 *    message the UI does not render, and a second wake for a commitment that
 *    has moved on is answered in one line.
 *
 * Every step is ordered so that a crash leaves recoverable state: the attempt
 * is written before the send, and the commitment stays leased until the
 * outcome is known. A lease that expires mid-delivery returns the row to the
 * claim with its wake_seq — and therefore its delivery id — intact.
 */

export type SendOutcome =
  /** The receiver accepted it. */
  | { kind: "accepted" }
  /** The session is gone; a new one has to be created for this thread. */
  | { kind: "session_not_active" }
  /** It definitely did not arrive: refused connection, 4xx that is not 409. */
  | { kind: "refused"; error: unknown }
  /** It may or may not have arrived: timeout, reset, crash after the request. */
  | { kind: "ambiguous"; error: unknown };

export type Sender = (input: {
  sessionId: string;
  message: string;
  commitment: Commitment;
  delivery: Delivery;
}) => Promise<SendOutcome>;

/** Did a wake carrying this marker already land in the session? */
export type Reconciler = (input: {
  sessionId: string;
  marker: string;
  commitment: Commitment;
}) => Promise<boolean>;

/** Resolves the session a thread's wake should go to. */
export type TargetResolver = (commitment: Commitment) => Promise<{
  sessionId: string;
  kind: "existing_session" | "new_session";
} | null>;

export type DeliveryResult =
  | { status: "delivered"; deliveryId: string; deduplicated: boolean }
  | { status: "skipped"; reason: "cancelled" | "already_handled" | "lease_lost" }
  | { status: "deferred"; reason: "refused" | "ambiguous" | "no_target" }
  | { status: "abandoned"; reason: string };

export async function deliverCommitment(input: {
  client: SupabaseClient;
  commitment: Commitment;
  leaseToken: string;
  resolveTarget: TargetResolver;
  send: Sender;
  reconcile: Reconciler;
  buildMessage: (commitment: Commitment, marker: string) => string;
  now?: Date;
}): Promise<DeliveryResult> {
  const { client, leaseToken } = input;
  const now = input.now ?? new Date();

  // 1. Cancellation wins over a wake in flight. Re-read inside the delivery,
  //    not before the claim, so the window is as narrow as the send itself.
  const current = await readCommitment(client, input.commitment.id);
  if (!current || isTerminal(current.status)) {
    const reason = current?.status === "cancelled" ? "cancelled" : "already_handled";
    const delivery = current ? await openDelivery(client, current) : null;
    if (delivery && delivery.state !== "confirmed") {
      await markDelivery(client, delivery, { state: "abandoned", reason });
    }
    if (current) {
      await releaseLease(client, current, leaseToken);
    }
    return { status: "skipped", reason };
  }

  const commitment = current;
  const delivery = await openDelivery(client, commitment);

  // 2. Already confirmed: another worker finished this reminder.
  if (delivery.state === "confirmed") {
    await markDelivered(client, commitment, leaseToken);
    return { status: "delivered", deliveryId: delivery.id, deduplicated: true };
  }

  // 3. Anything that has been tried before is reconciled before it is retried.
  //    This is the ambiguous window: a send that timed out may still have been
  //    accepted, and the marker is how we find out.
  if (delivery.attempts > 0 && delivery.target_session_id) {
    const landed = await input.reconcile({
      sessionId: delivery.target_session_id,
      marker: delivery.marker,
      commitment,
    });
    if (landed) {
      await markDelivery(client, delivery, { state: "confirmed" });
      await recordEvent(client, {
        workspaceId: commitment.workspace_id,
        assistantId: commitment.assistant_id,
        subjectType: "delivery",
        subjectId: delivery.id,
        type: "confirmed",
        threadId: commitment.thread_id,
        eveSessionId: delivery.target_session_id,
        payload: { deduplicated: true, attempts: delivery.attempts },
        idempotencyKey: `delivery:${delivery.id}:confirmed`,
      });
      await markDelivered(client, commitment, leaseToken);
      return { status: "delivered", deliveryId: delivery.id, deduplicated: true };
    }
  }

  // 4. Out of attempts: record the miss rather than losing it.
  if (delivery.attempts >= WAKE_MAX_ATTEMPTS) {
    await markDelivery(client, delivery, {
      state: "abandoned",
      reason: "max_attempts",
    });
    await recordEvent(client, {
      workspaceId: commitment.workspace_id,
      assistantId: commitment.assistant_id,
      subjectType: "commitment",
      subjectId: commitment.id,
      type: "wake_failed",
      threadId: commitment.thread_id,
      payload: { deliveryId: delivery.id, attempts: delivery.attempts },
      idempotencyKey: `commitment:${commitment.id}:wake:${commitment.wake_seq}:failed`,
    });
    await markWakeFailed(client, commitment, leaseToken, {
      reason: "max_attempts",
      attempts: delivery.attempts,
    });
    return { status: "abandoned", reason: "max_attempts" };
  }

  const target = await input.resolveTarget(commitment);
  if (!target) {
    await releaseLease(client, commitment, leaseToken);
    return { status: "deferred", reason: "no_target" };
  }

  // 5. Write-ahead: the attempt is durable before the send leaves the process.
  const attempt = await beginAttempt(client, delivery, target, now);

  const outcome = await input.send({
    sessionId: target.sessionId,
    message: input.buildMessage(commitment, attempt.marker),
    commitment,
    delivery: attempt,
  });

  if (outcome.kind === "accepted") {
    await markDelivery(client, attempt, { state: "sent", at: now });
    await recordEvent(client, {
      workspaceId: commitment.workspace_id,
      assistantId: commitment.assistant_id,
      subjectType: "delivery",
      subjectId: attempt.id,
      type: "sent",
      threadId: commitment.thread_id,
      eveSessionId: target.sessionId,
      payload: { attempts: attempt.attempts, targetKind: target.kind },
      idempotencyKey: `delivery:${attempt.id}:sent`,
    });
    const kept = await markDelivered(client, commitment, leaseToken);
    return {
      status: kept ? "delivered" : "delivered",
      deliveryId: attempt.id,
      deduplicated: false,
    };
  }

  if (outcome.kind === "session_not_active") {
    // The row stays pending with the attempt spent; the caller creates a new
    // session for this thread and the next pass delivers into it.
    await markDelivery(client, attempt, {
      state: "pending",
      error: { reason: "session_not_active" },
    });
    await releaseLease(client, commitment, leaseToken);
    return { status: "deferred", reason: "no_target" };
  }

  await markDelivery(client, attempt, {
    state: "pending",
    error: serialiseError(outcome.error),
  });
  await releaseLease(client, commitment, leaseToken);
  return { status: "deferred", reason: outcome.kind };
}

function serialiseError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}
