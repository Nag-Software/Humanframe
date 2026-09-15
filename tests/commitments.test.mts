import { randomUUID } from "node:crypto";

import {
  WAKE_MAX_ATTEMPTS,
  backoffSeconds,
  cancelCommitment,
  claimDueCommitments,
  completeCommitment,
  createCommitment,
  deliveryMarker,
  openDelivery,
  readCommitment,
  recordEvent,
  releaseLease,
  rescheduleCommitment,
  updateWithLease,
  type Commitment,
  type CommitmentScope,
} from "../agent/lib/commitments.ts";
import {
  deliverCommitment,
  type Reconciler,
  type SendOutcome,
  type Sender,
} from "../agent/lib/delivery.ts";
import { effectKey, performOnce, readEffect } from "../agent/lib/effects.ts";
import { admin, createTestWorkspace, type TestWorkspace } from "./memory-support.mts";

/**
 * Deterministic tests for the wake machinery. No model calls and no HTTP: the
 * sender and the reconciler are seams, so a timeout, a crash and a duplicate
 * are things the test states rather than things it has to provoke.
 *
 * The database is real, because the claim's atomicity, the lease and the
 * composite foreign keys are the things under test.
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
  if (error || !data) {
    throw new Error(`thread insert failed: ${error?.message}`);
  }
  return data.id;
}

function scopeOf(workspace: TestWorkspace): CommitmentScope {
  return {
    client: admin,
    workspaceId: workspace.workspaceId,
    assistantId: workspace.assistantId,
  };
}

const PAST = () => new Date(Date.now() - 60_000).toISOString();
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

async function due(
  workspace: TestWorkspace,
  threadId: string,
  label: string,
  dueAt = PAST()
): Promise<Commitment> {
  return createCommitment(scopeOf(workspace), {
    threadId,
    title: label,
    dueAt,
    dueTimezone: "Europe/Oslo",
    dedupeKey: `${label}-${randomUUID()}`,
  });
}

/** A sender that records what it was asked to do and answers as instructed. */
function scriptedSender(outcomes: SendOutcome[]): Sender & { calls: string[] } {
  const calls: string[] = [];
  const sender = (async (input) => {
    calls.push(input.message);
    return outcomes.shift() ?? { kind: "accepted" };
  }) as Sender & { calls: string[] };
  sender.calls = calls;
  return sender;
}

const neverLanded: Reconciler = async () => false;
const alreadyLanded: Reconciler = async () => true;

const resolveTo = (sessionId: string) => async () =>
  ({ sessionId, kind: "existing_session" }) as const;

const wakePrompt = (commitment: Commitment, marker: string) =>
  `${marker} ${commitment.title}`;

/** What the passage of time does: the backoff window has elapsed. */
async function backoffElapsed(commitmentId: string): Promise<void> {
  await admin
    .from("commitment_deliveries")
    .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() })
    .eq("commitment_id", commitmentId);
}

async function main(): Promise<void> {
  const alpha = await createTestWorkspace("commit-a");
  const beta = await createTestWorkspace("commit-b");

  try {
    const thread = await createThread(alpha, "Phase 4 tests");
    const betaThread = await createThread(beta, "Other tenant");

    // --- 1. Concurrent claims -------------------------------------------
    {
      const commitment = await due(alpha, thread, "concurrent");
      const [first, second] = await Promise.all([
        claimDueCommitments(admin, { limit: 10 }),
        claimDueCommitments(admin, { limit: 10 }),
      ]);
      const claims = [...first, ...second].filter((row) => row.id === commitment.id);
      check("a due commitment is claimed exactly once by concurrent callers",
        claims.length === 1, { claims: claims.length });
      check("the claim opens a logical reminder", claims[0]?.wake_seq === 1,
        { wakeSeq: claims[0]?.wake_seq });
      check("the claim hands out a lease", Boolean(claims[0]?.lease_token));
    }

    // --- 2. A live lease blocks re-claiming ------------------------------
    {
      const commitment = await due(alpha, thread, "live-lease");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id, leaseMs: 60_000 });
      const again = await claimDueCommitments(admin, { id: commitment.id });
      check("a live lease is not re-claimable", again.length === 0);
      check("the leased row is the one claimed", claimed?.id === commitment.id);
    }

    // --- 3. A stranded waking row is recovered, keeping its identity -----
    {
      const commitment = await due(alpha, thread, "stranded");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      const delivery = await openDelivery(admin, claimed);

      // The worker dies: the row stays 'waking' and its lease runs out.
      await admin
        .from("commitments")
        .update({ lease_until: new Date(Date.now() - 1000).toISOString() })
        .eq("id", commitment.id);

      const [recovered] = await claimDueCommitments(admin, { id: commitment.id });
      check("a stranded waking row with an expired lease is recovered",
        recovered?.id === commitment.id);
      check("recovery keeps wake_seq, so it is the same logical reminder",
        recovered?.wake_seq === claimed.wake_seq,
        { before: claimed.wake_seq, after: recovered?.wake_seq });
      check("recovery issues a new lease token",
        Boolean(recovered?.lease_token) && recovered?.lease_token !== claimed.lease_token);

      const sameDelivery = await openDelivery(admin, recovered);
      check("recovery keeps the delivery id", sameDelivery.id === delivery.id);
      check("the marker is stable across recovery",
        sameDelivery.marker === deliveryMarker(delivery.id));
    }

    // --- 4. A stale lease writes nothing ---------------------------------
    {
      const commitment = await due(alpha, thread, "stale-lease");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      const stale = randomUUID();
      const wrote = await updateWithLease(admin, claimed, stale, { status: "delivered" });
      check("a state change with a stale lease token writes nothing", wrote === false);
      const after = await readCommitment(admin, commitment.id);
      check("the row is untouched by the losing worker", after?.status === "waking",
        { status: after?.status });
      const owner = await updateWithLease(admin, claimed, claimed.lease_token!, {
        status: "delivered",
      });
      check("the lease holder can still write", owner === true);
    }

    // --- 5. Delivery identity is stable; attempts are not identity -------
    {
      const commitment = await due(alpha, thread, "identity");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      const sender = scriptedSender([{ kind: "ambiguous", error: new Error("socket hang up") }]);
      const first = await deliverCommitment({
        client: admin, commitment: claimed, leaseToken: claimed.lease_token!,
        resolveTarget: resolveTo("ses_identity"), send: sender,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });
      check("an ambiguous send defers", first.status === "deferred", first);

      await backoffElapsed(commitment.id);
      const [reclaimed] = await claimDueCommitments(admin, { id: commitment.id });
      const delivery = await openDelivery(admin, reclaimed);
      check("the retry is the same delivery id",
        delivery.marker === sender.calls[0]?.split(" ")[0]);
      check("attempts advanced without changing identity", delivery.attempts === 1,
        { attempts: delivery.attempts });
      check("backoff grows with attempts", backoffSeconds(1) < backoffSeconds(3));
    }

    // --- 6. Crash before the send: exactly one message is sent -----------
    {
      const commitment = await due(alpha, thread, "crash-before-send");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });

      // Simulate the process dying after the attempt was written: the row is
      // pending with attempts = 1 and nothing was ever sent.
      const delivery = await openDelivery(admin, claimed);
      await admin
        .from("commitment_deliveries")
        .update({ attempts: 1, target_session_id: "ses_crash", target_kind: "existing_session" })
        .eq("id", delivery.id);
      await admin
        .from("commitments")
        .update({ lease_until: new Date(Date.now() - 1000).toISOString() })
        .eq("id", commitment.id);

      const [recovered] = await claimDueCommitments(admin, { id: commitment.id });
      const sender = scriptedSender([{ kind: "accepted" }]);
      const result = await deliverCommitment({
        client: admin, commitment: recovered, leaseToken: recovered.lease_token!,
        resolveTarget: resolveTo("ses_crash"), send: sender,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });
      check("a crash before the send retries and delivers", result.status === "delivered", result);
      check("it sent exactly one message", sender.calls.length === 1);
      const after = await readCommitment(admin, commitment.id);
      check("the commitment is marked delivered", after?.status === "delivered",
        { status: after?.status });
    }

    // --- 7 & 8. Ambiguous send that actually landed ----------------------
    {
      const commitment = await due(alpha, thread, "ambiguous-landed");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      const timingOut = scriptedSender([{ kind: "ambiguous", error: new Error("timeout") }]);
      await deliverCommitment({
        client: admin, commitment: claimed, leaseToken: claimed.lease_token!,
        resolveTarget: resolveTo("ses_amb"), send: timingOut,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });

      // The receiver had accepted it after all: the marker is in the thread.
      await backoffElapsed(commitment.id);
      const [reclaimed] = await claimDueCommitments(admin, { id: commitment.id });
      const resender = scriptedSender([{ kind: "accepted" }]);
      const result = await deliverCommitment({
        client: admin, commitment: reclaimed, leaseToken: reclaimed.lease_token!,
        resolveTarget: resolveTo("ses_amb"), send: resender,
        reconcile: alreadyLanded, buildMessage: wakePrompt,
      });
      check("reconciliation confirms a send that had already landed",
        result.status === "delivered" && result.deduplicated, result);
      check("no duplicate wake is sent", resender.calls.length === 0);

      const delivery = await openDelivery(admin, reclaimed);
      check("the delivery is confirmed", delivery.state === "confirmed",
        { state: delivery.state });
      const { data: events } = await admin
        .from("events")
        .select("type")
        .eq("subject_id", delivery.id);
      check("one confirmation event is recorded", (events ?? []).length === 1,
        { events: events?.length });
    }

    // --- 9. Attempts exhausted -------------------------------------------
    {
      const commitment = await due(alpha, thread, "exhausted");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      const delivery = await openDelivery(admin, claimed);
      await admin
        .from("commitment_deliveries")
        .update({ attempts: WAKE_MAX_ATTEMPTS, target_session_id: "ses_dead" })
        .eq("id", delivery.id);

      const sender = scriptedSender([{ kind: "accepted" }]);
      const result = await deliverCommitment({
        client: admin, commitment: claimed, leaseToken: claimed.lease_token!,
        resolveTarget: resolveTo("ses_dead"), send: sender,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });
      check("an exhausted delivery is abandoned", result.status === "abandoned", result);
      check("nothing more is sent", sender.calls.length === 0);
      const after = await readCommitment(admin, commitment.id);
      check("the commitment is marked failed, not lost", after?.status === "failed",
        { status: after?.status });
      const { data: events } = await admin
        .from("events")
        .select("type")
        .eq("subject_id", commitment.id)
        .eq("type", "wake_failed");
      check("the miss is recorded as an event", (events ?? []).length === 1);
    }

    // --- 10. Cancelled before the deadline --------------------------------
    {
      const commitment = await createCommitment(scopeOf(alpha), {
        threadId: thread,
        title: "cancelled-early",
        dueAt: FUTURE(),
        dueTimezone: "Europe/Oslo",
        dedupeKey: `cancelled-early-${randomUUID()}`,
      });
      const cancelled = await cancelCommitment(scopeOf(alpha), commitment.id);
      check("cancelling before the deadline succeeds", cancelled);

      // Make it due: a cancelled row must still never be claimed.
      await admin.from("commitments").update({ due_at: PAST() }).eq("id", commitment.id);
      const claims = await claimDueCommitments(admin, { id: commitment.id });
      check("a cancelled commitment is never claimed", claims.length === 0);
      const { data: deliveries } = await admin
        .from("commitment_deliveries")
        .select("id")
        .eq("commitment_id", commitment.id);
      check("no delivery row is created for it", (deliveries ?? []).length === 0);
    }

    // --- 11. Cancelled between claim and send -----------------------------
    {
      const commitment = await due(alpha, thread, "cancel-race");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      await cancelCommitment(scopeOf(alpha), commitment.id);

      const sender = scriptedSender([{ kind: "accepted" }]);
      const result = await deliverCommitment({
        client: admin, commitment: claimed, leaseToken: claimed.lease_token!,
        resolveTarget: resolveTo("ses_race"), send: sender,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });
      check("a cancellation after the claim stops the delivery",
        result.status === "skipped" && result.reason === "cancelled", result);
      check("nothing is sent and no turn is started", sender.calls.length === 0);
      const delivery = await openDelivery(admin, claimed);
      check("the delivery is abandoned as cancelled",
        delivery.state === "abandoned" && delivery.abandoned_reason === "cancelled",
        { state: delivery.state, reason: delivery.abandoned_reason });
    }

    // --- 12. A commitment completed before its wake -----------------------
    {
      const commitment = await due(alpha, thread, "already-done");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      await completeCommitment(scopeOf(alpha), commitment.id);
      const sender = scriptedSender([{ kind: "accepted" }]);
      const result = await deliverCommitment({
        client: admin, commitment: claimed, leaseToken: claimed.lease_token!,
        resolveTarget: resolveTo("ses_done"), send: sender,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });
      check("a commitment completed before its wake delivers nothing",
        result.status === "skipped" && result.reason === "already_handled", result);
      check("no wake message is sent", sender.calls.length === 0);
    }

    // --- 12a. Two workers racing one commitment produce one wake -----------
    {
      const commitment = await due(alpha, thread, "race");
      const claims = await Promise.all([
        claimDueCommitments(admin, { id: commitment.id }),
        claimDueCommitments(admin, { id: commitment.id }),
      ]);
      const winners = claims.flat();
      check("only one worker may deliver a commitment", winners.length === 1,
        { winners: winners.length });

      // The loser tries anyway, with a lease it does not hold.
      const loserSender = scriptedSender([{ kind: "accepted" }]);
      const loser = await deliverCommitment({
        client: admin, commitment: winners[0], leaseToken: randomUUID(),
        resolveTarget: resolveTo("ses_race2"), send: loserSender,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });
      const winnerSender = scriptedSender([{ kind: "accepted" }]);
      const winner = await deliverCommitment({
        client: admin, commitment: winners[0], leaseToken: winners[0].lease_token!,
        resolveTarget: resolveTo("ses_race2"), send: winnerSender,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });
      const sends = loserSender.calls.length + winnerSender.calls.length;
      check("exactly one visible wake is sent when two workers race", sends === 1,
        { loser: loserSender.calls.length, winner: winnerSender.calls.length, loser_result: loser.status, winner_result: winner.status });
    }

    // --- 12b. A sent delivery is never resent ------------------------------
    {
      const commitment = await due(alpha, thread, "sent-wins");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      const first = scriptedSender([{ kind: "accepted" }]);
      await deliverCommitment({
        client: admin, commitment: claimed, leaseToken: claimed.lease_token!,
        resolveTarget: resolveTo("ses_sent"), send: first,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });

      // Force it back into the claim, with a reconciler that lies: the message
      // projection has not caught up. The row's own state has to win.
      await admin
        .from("commitments")
        .update({ status: "waking", lease_until: new Date(Date.now() - 1000).toISOString() })
        .eq("id", commitment.id);
      const [again] = await claimDueCommitments(admin, { id: commitment.id });
      const second = scriptedSender([{ kind: "accepted" }]);
      const result = await deliverCommitment({
        client: admin, commitment: again, leaseToken: again.lease_token!,
        resolveTarget: resolveTo("ses_sent"), send: second,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });
      check("a sent delivery is not resent even when the marker lookup fails",
        second.calls.length === 0, { sends: second.calls.length, result });
      check("it reports as delivered and deduplicated",
        result.status === "delivered" && result.deduplicated, result);
    }

    // --- 12c. Backoff is a hard gate ---------------------------------------
    {
      const commitment = await due(alpha, thread, "backoff");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      const failing = scriptedSender([{ kind: "ambiguous", error: new Error("reset") }]);
      await deliverCommitment({
        client: admin, commitment: claimed, leaseToken: claimed.lease_token!,
        resolveTarget: resolveTo("ses_backoff"), send: failing,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });

      const [again] = await claimDueCommitments(admin, { id: commitment.id });
      const tooSoon = scriptedSender([{ kind: "accepted" }]);
      const result = await deliverCommitment({
        client: admin, commitment: again, leaseToken: again.lease_token!,
        resolveTarget: resolveTo("ses_backoff"), send: tooSoon,
        reconcile: neverLanded, buildMessage: wakePrompt,
      });
      check("a retry before next_attempt_at is refused",
        result.status === "deferred" && result.reason === "backoff", result);
      check("nothing is sent during the backoff window", tooSoon.calls.length === 0);
    }

    // --- 12d. An action runs at most once, however many wakes arrive -------
    {
      const commitment = await due(alpha, thread, "effect-once");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      let performed = 0;
      const subject = {
        type: "commitment" as const,
        id: commitment.id,
        wakeSeq: claimed.wake_seq,
      };
      const run = () =>
        performOnce(
          admin,
          {
            workspaceId: alpha.workspaceId,
            assistantId: alpha.assistantId,
            subject,
            name: "send_followup_email",
          },
          async () => {
            performed += 1;
            return { messageId: "msg-1" };
          }
        );

      const first = await run();
      const second = await run();
      check("the first wake performs the action", first.status === "performed");
      check("a second wake does not perform it again",
        second.status === "already_performed", second);
      check("the effect ran exactly once", performed === 1, { performed });

      const ledger = await readEffect(
        admin, alpha.workspaceId, effectKey(subject, "send_followup_email"));
      check("the ledger records the result", ledger?.state === "succeeded");
      check("the key is derived from the business subject, not the attempt",
        ledger?.idempotency_key ===
          `commitment:${commitment.id}:wake:${claimed.wake_seq}:action:send_followup_email`,
        ledger?.idempotency_key);
    }

    // --- 12e. A crashed effect is retried, not abandoned --------------------
    {
      const commitment = await due(alpha, thread, "effect-crash");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      const subject = {
        type: "commitment" as const,
        id: commitment.id,
        wakeSeq: claimed.wake_seq,
      };
      let attempts = 0;

      try {
        await performOnce(
          admin,
          { workspaceId: alpha.workspaceId, subject, name: "flaky" },
          async () => {
            attempts += 1;
            throw new Error("provider exploded");
          }
        );
      } catch {
        // expected
      }

      const retried = await performOnce(
        admin,
        { workspaceId: alpha.workspaceId, subject, name: "flaky" },
        async () => {
          attempts += 1;
          return { ok: true };
        }
      );
      check("a failed effect is retried", retried.status === "performed", retried);
      check("it ran twice in total, not more", attempts === 2, { attempts });
    }

    // --- 12f. A live lease blocks a concurrent effect -----------------------
    {
      const commitment = await due(alpha, thread, "effect-inflight");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      const subject = {
        type: "commitment" as const,
        id: commitment.id,
        wakeSeq: claimed.wake_seq,
      };
      let concurrent: Awaited<ReturnType<typeof performOnce>> | null = null;

      await performOnce(
        admin,
        { workspaceId: alpha.workspaceId, subject, name: "slow" },
        async () => {
          concurrent = await performOnce(
            admin,
            { workspaceId: alpha.workspaceId, subject, name: "slow" },
            async () => ({ shouldNotRun: true })
          );
          return { ok: true };
        }
      );
      check("an effect already in flight is not started a second time",
        concurrent !== null && (concurrent as { status: string }).status === "in_flight",
        concurrent);
    }

    // --- 13. Events are idempotent ----------------------------------------
    {
      const commitment = await due(alpha, thread, "event-idempotence");
      const key = `commitment:${commitment.id}:test`;
      const first = await recordEvent(admin, {
        workspaceId: alpha.workspaceId, subjectType: "commitment",
        subjectId: commitment.id, type: "test", idempotencyKey: key,
      });
      const second = await recordEvent(admin, {
        workspaceId: alpha.workspaceId, subjectType: "commitment",
        subjectId: commitment.id, type: "test", idempotencyKey: key,
      });
      check("the first writer of an event wins", first === true);
      check("a replayed event writes nothing and says so", second === false);
    }

    // --- 14. Composite foreign keys on the service-role path ---------------
    {
      const crossThread = await admin.from("commitments").insert({
        workspace_id: alpha.workspaceId,
        assistant_id: alpha.assistantId,
        thread_id: betaThread,               // another workspace's thread
        title: "cross-tenant thread",
        due_at: PAST(),
        due_timezone: "UTC",
        dedupe_key: `cross-thread-${randomUUID()}`,
      });
      check("service role cannot point a commitment at another workspace's thread",
        crossThread.error !== null, crossThread.error?.code);

      const crossAssistant = await admin.from("commitments").insert({
        workspace_id: alpha.workspaceId,
        assistant_id: beta.assistantId,      // another workspace's assistant
        thread_id: thread,
        title: "cross-tenant assistant",
        due_at: PAST(),
        due_timezone: "UTC",
        dedupe_key: `cross-assistant-${randomUUID()}`,
      });
      check("service role cannot point a commitment at another workspace's assistant",
        crossAssistant.error !== null, crossAssistant.error?.code);

      const goal = await admin.from("goals").insert({
        workspace_id: beta.workspaceId,
        assistant_id: beta.assistantId,
        title: "beta goal",
        dedupe_key: `beta-goal-${randomUUID()}`,
      }).select("id").single<{ id: string }>();

      const crossGoal = await admin.from("commitments").insert({
        workspace_id: alpha.workspaceId,
        assistant_id: alpha.assistantId,
        thread_id: thread,
        goal_id: goal.data!.id,              // another workspace's goal
        title: "cross-tenant goal",
        due_at: PAST(),
        due_timezone: "UTC",
        dedupe_key: `cross-goal-${randomUUID()}`,
      });
      check("service role cannot point a commitment at another workspace's goal",
        crossGoal.error !== null, crossGoal.error?.code);
    }

    // --- 15. RLS on the browser path ---------------------------------------
    {
      const commitment = await due(alpha, thread, "rls");
      const { data: leaked } = await beta.userClient
        .from("commitments")
        .select("id")
        .eq("id", commitment.id);
      check("another tenant cannot read a commitment", (leaked ?? []).length === 0);

      const { data: stolen } = await beta.userClient
        .from("commitments")
        .update({ status: "cancelled" })
        .eq("id", commitment.id)
        .select("id");
      check("another tenant cannot write a commitment", (stolen ?? []).length === 0);

      const { error: rpcError } = await beta.userClient.rpc("claim_commitments_for_wake", {
        p_limit: 10, p_lease_ms: 60_000, p_id: commitment.id,
      });
      check("the claim is not callable by a browser session", rpcError !== null,
        rpcError?.code);
    }

    // --- 16. Releasing a lease returns the row to the pool ------------------
    {
      const commitment = await due(alpha, thread, "release");
      const [claimed] = await claimDueCommitments(admin, { id: commitment.id });
      const released = await releaseLease(admin, claimed, claimed.lease_token!);
      check("the lease holder can release the row", released);
      const [again] = await claimDueCommitments(admin, { id: commitment.id });
      check("a released row is immediately claimable again", again?.id === commitment.id);
      check("releasing keeps the logical reminder, so a retry keeps its identity",
        again?.wake_seq === claimed.wake_seq,
        { before: claimed.wake_seq, after: again?.wake_seq });

      // A reschedule is the operation that does open a new reminder.
      await rescheduleCommitment(scopeOf(alpha), commitment.id, PAST());
      const [rescheduled] = await claimDueCommitments(admin, { id: commitment.id });
      check("a reschedule opens a new logical reminder",
        rescheduled?.wake_seq === claimed.wake_seq + 1,
        { before: claimed.wake_seq, after: rescheduled?.wake_seq });
    }

    // --- 17. Creating a commitment is idempotent ----------------------------
    {
      const key = `idempotent-${randomUUID()}`;
      const first = await createCommitment(scopeOf(alpha), {
        threadId: thread, title: "same call", dueAt: PAST(),
        dueTimezone: "Europe/Oslo", dedupeKey: key,
      });
      const second = await createCommitment(scopeOf(alpha), {
        threadId: thread, title: "same call", dueAt: PAST(),
        dueTimezone: "Europe/Oslo", dedupeKey: key,
      });
      check("a replayed step claims the same commitment row", first.id === second.id);
    }
  } finally {
    await alpha.remove();
    await beta.remove();
  }

  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed > 0) {
    process.exit(1);
  }
}

await main();
