import type { SupabaseClient } from "@supabase/supabase-js";

import {
  claimDueCommitments,
  DEFAULT_LEASE_MS,
  deliveryMarker,
  type Commitment,
} from "./commitments";
import {
  deliverCommitment,
  type DeliveryResult,
  type Reconciler,
  type SendOutcome,
  type Sender,
  type TargetResolver,
} from "./delivery";
import { currentProjectBinding, readInternalToken } from "./internal-auth";
import { getRuntimeSupabase } from "./supabase";

/**
 * The wake path: claim a commitment, then deliver it.
 *
 * Both triggers end up here. `wakeCommitment` is what a commitment's own
 * durable timer calls when it wakes; `sweepWakes` is what the heartbeat calls
 * to find commitments whose timer never fired. There is no second
 * implementation — same claim, same lease, same delivery protocol, same
 * cancellation check.
 */

const RECAP_MESSAGES = 6;
const RECAP_CHARACTERS = 1200;

export type WakeOutcome =
  | { status: "no_work" }
  | ({ commitmentId: string } & DeliveryResult);

/** One commitment, by id. The timer's entry point. */
export async function wakeCommitment(
  commitmentId: string,
  options: { client?: SupabaseClient; now?: Date } = {}
): Promise<WakeOutcome> {
  const client = options.client ?? getRuntimeSupabase();
  if (!client) {
    return { status: "no_work" };
  }

  const [claimed] = await claimDueCommitments(client, {
    id: commitmentId,
    limit: 1,
    leaseMs: DEFAULT_LEASE_MS,
  });

  // No row means there is nothing to do, and that is the normal case for a
  // cancelled or completed commitment: the claim only returns rows that are
  // still `scheduled` or `waking`. Nothing is delivered, and because this runs
  // in a detached workflow rather than a session-attached task, no turn is
  // started either.
  if (!claimed) {
    return { status: "no_work" };
  }

  return { commitmentId, ...(await runDelivery(client, claimed, options.now)) };
}

/** Everything due and unleased. The heartbeat's entry point. */
export async function sweepWakes(
  options: { client?: SupabaseClient; limit?: number; now?: Date } = {}
): Promise<WakeOutcome[]> {
  const client = options.client ?? getRuntimeSupabase();
  if (!client) {
    return [];
  }

  const claimed = await claimDueCommitments(client, {
    limit: options.limit ?? 25,
    leaseMs: DEFAULT_LEASE_MS,
  });

  const outcomes: WakeOutcome[] = [];
  for (const commitment of claimed) {
    try {
      outcomes.push({
        commitmentId: commitment.id,
        ...(await runDelivery(client, commitment, options.now)),
      });
    } catch (error) {
      // One commitment must never take the sweep down with it; the lease
      // expires and the next tick retries this row.
      console.error(
        JSON.stringify({
          level: "error",
          event: "wake.sweep_failed",
          commitmentId: commitment.id,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
  return outcomes;
}

async function runDelivery(
  client: SupabaseClient,
  commitment: Commitment,
  now?: Date
): Promise<DeliveryResult> {
  return deliverCommitment({
    client,
    commitment,
    leaseToken: commitment.lease_token!,
    resolveTarget: resolveTarget(client),
    send: sendWake,
    reconcile: reconcileWake(client),
    buildMessage: buildWakeMessage,
    now,
  });
}

/**
 * The session a wake goes to: the thread's current session, or the most recent
 * one it ever had. Both are checked against the commitment's workspace, so a
 * target that belongs to another tenant is refused before anything is sent.
 */
export function resolveTarget(client: SupabaseClient): TargetResolver {
  return async (commitment) => {
    const { data: thread } = await client
      .from("threads")
      .select("id, workspace_id, eve_session_id")
      .eq("id", commitment.thread_id)
      .maybeSingle<{ id: string; workspace_id: string; eve_session_id: string | null }>();

    if (!thread || thread.workspace_id !== commitment.workspace_id) {
      return null;
    }
    if (thread.eve_session_id) {
      return { sessionId: thread.eve_session_id, kind: "existing_session" };
    }

    const { data: session } = await client
      .from("thread_sessions")
      .select("eve_session_id, workspace_id")
      .eq("thread_id", commitment.thread_id)
      .eq("workspace_id", commitment.workspace_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ eve_session_id: string; workspace_id: string }>();

    if (!session) {
      return null;
    }
    return { sessionId: session.eve_session_id, kind: "existing_session" };
  };
}

/**
 * Has a wake carrying this marker already landed?
 *
 * Advisory only. It reads `messages`, which `persist-turn.ts` writes from a
 * hook, so a send that landed moments ago may not be visible yet. It can
 * prevent a resend; it can never authorise one.
 */
export function reconcileWake(client: SupabaseClient): Reconciler {
  return async ({ sessionId, marker, commitment }) => {
    const { data } = await client
      .from("messages")
      .select("id")
      .eq("workspace_id", commitment.workspace_id)
      .eq("eve_session_id", sessionId)
      .ilike("content::text", `%${marker}%`)
      .limit(1);
    return (data?.length ?? 0) > 0;
  };
}

/**
 * Posts the wake to our own eve channel.
 *
 * The token is read here, at send time, and never earlier: a token captured
 * before a multi-day sleep is expired by the time it is used, and a token in
 * workflow input or a step result would be written into durable history.
 */
export const sendWake: Sender = async ({ sessionId, message, signal }) => {
  const origin = internalOrigin();
  const token = readInternalToken();
  if (!origin || !token || !currentProjectBinding()) {
    return { kind: "refused", error: { reason: "internal_delivery_unconfigured" } };
  }

  try {
    const response = await fetch(`${origin}/eve/v1/session/${sessionId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-humanframe-internal": "delivery",
      },
      body: JSON.stringify({ message }),
      signal,
    });

    if (response.ok) {
      return { kind: "accepted" };
    }
    if (response.status === 409) {
      return { kind: "session_not_active" };
    }
    if (response.status >= 500) {
      // The receiver may have taken it before failing to answer.
      return { kind: "ambiguous", error: { status: response.status } };
    }
    return { kind: "refused", error: { status: response.status } };
  } catch (error) {
    // A timeout or a reset proves nothing about whether it arrived.
    return { kind: "ambiguous", error };
  }
};

export function internalOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  if (env.VERCEL_URL) {
    return `https://${env.VERCEL_URL}`;
  }
  return env.APP_URL ?? null;
}

/**
 * What Maya is woken with.
 *
 * The marker leads, so a retry can recognise its own work and `persist-turn`
 * can file it on the system channel instead of rendering it as something the
 * user said. The rest is the commitment, in plain language, and the judgement
 * she is being asked to make.
 */
export function buildWakeMessage(commitment: Commitment, marker: string): string {
  const due = new Date(commitment.due_at).toISOString();
  return [
    marker,
    `A commitment you made is due now: "${commitment.title}".`,
    commitment.detail ? `Detail: ${commitment.detail}` : null,
    `It was due at ${due} (${commitment.due_timezone}).`,
    "",
    "Decide what this needs. Do it if you can do it now; prepare it if it needs",
    "the user's input; ask for approval if it has an effect outside this",
    "conversation; or simply tell them it is due. Say what you did either way.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** The marker a wake carries, so other modules can recognise one. */
export const WAKE_MARKER_PREFIX = "[humanframe:delivery:";

export function isWakeMessage(text: string): boolean {
  return text.trimStart().startsWith(WAKE_MARKER_PREFIX);
}

export { deliveryMarker, RECAP_CHARACTERS, RECAP_MESSAGES };
