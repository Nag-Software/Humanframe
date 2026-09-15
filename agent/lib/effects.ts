import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The effect ledger.
 *
 * Delivery is at-least-once (see agent/lib/delivery.ts), and that is only
 * tolerable because actions are not. Every effect runs through `performOnce`,
 * under a key built from the business subject — never a uuid, a timestamp or an
 * attempt counter. A key that varies per attempt would make the ledger
 * decorative.
 *
 * The contract is at-most-once for the effect *and* at-least-once for the
 * attempt: a crash mid-effect leaves a claimed row whose lease expires, and the
 * next caller retries it. An effect that cannot tolerate that — a provider with
 * no idempotency key and no way to ask whether the call already happened — must
 * not run unattended; it goes through approval and a person absorbs the
 * ambiguity.
 */

export const EFFECT_LEASE_MS = 2 * 60_000;

export type EffectSubject =
  | { type: "commitment"; id: string; wakeSeq: number }
  | { type: "task"; id: string }
  | { type: "approval"; id: string };

export type EffectState = "claimed" | "succeeded" | "failed";

export type Effect = {
  id: string;
  workspace_id: string;
  subject_type: string;
  subject_id: string;
  name: string;
  idempotency_key: string;
  state: EffectState;
  attempts: number;
  result: unknown;
  error: unknown;
  lease_token: string | null;
};

/**
 * The key an effect is remembered by. Derived entirely from identifiers that
 * are stable for the life of the business object, so the same logical action
 * produces the same key on every replay, retry and duplicate wake.
 */
export function effectKey(subject: EffectSubject, name: string): string {
  switch (subject.type) {
    case "commitment":
      return `commitment:${subject.id}:wake:${subject.wakeSeq}:action:${name}`;
    case "task":
      return `task:${subject.id}:action:${name}`;
    case "approval":
      return `approval:${subject.id}:${name}`;
  }
}

export type PerformOutcome<T> =
  | { status: "performed"; result: T }
  | { status: "already_performed"; result: T }
  | { status: "in_flight" }
  | { status: "failed"; error: unknown };

/**
 * Runs `effect` at most once for this subject and name.
 *
 * - First caller: claims the row and runs the effect.
 * - A caller arriving while another holds a live lease: does nothing and says
 *   `in_flight`, rather than racing it.
 * - A caller arriving after success: returns the recorded result without
 *   running anything.
 * - A caller arriving after a crash left the lease expired: retries.
 */
export async function performOnce<T>(
  client: SupabaseClient,
  input: {
    workspaceId: string;
    assistantId?: string | null;
    subject: EffectSubject;
    name: string;
    payload?: Record<string, unknown>;
    leaseMs?: number;
  },
  effect: () => Promise<T>
): Promise<PerformOutcome<T>> {
  const key = effectKey(input.subject, input.name);

  const { data, error } = await client.rpc("claim_effect", {
    p_workspace_id: input.workspaceId,
    p_assistant_id: input.assistantId ?? null,
    p_subject_type: input.subject.type,
    p_subject_id: input.subject.id,
    p_name: input.name,
    p_idempotency_key: key,
    p_input: input.payload ?? {},
    p_lease_ms: input.leaseMs ?? EFFECT_LEASE_MS,
  });

  if (error) {
    throw new Error(`claim_effect failed: ${error.message}`);
  }

  const claimed = (data ?? [])[0] as Effect | undefined;
  if (!claimed) {
    // Either it already succeeded, or someone else is running it right now.
    const existing = await readEffect(client, input.workspaceId, key);
    if (existing?.state === "succeeded") {
      return { status: "already_performed", result: existing.result as T };
    }
    if (existing?.state === "failed") {
      return { status: "failed", error: existing.error };
    }
    return { status: "in_flight" };
  }

  try {
    const result = await effect();
    await client
      .from("effects")
      .update({
        state: "succeeded",
        result: (result ?? null) as never,
        completed_at: new Date().toISOString(),
        lease_token: null,
        lease_until: null,
      })
      .eq("id", claimed.id)
      .eq("lease_token", claimed.lease_token);
    return { status: "performed", result };
  } catch (thrown) {
    // The lease is dropped but the row stays `claimed`, so a retry is allowed:
    // a thrown error does not prove the effect did not happen, and the ledger
    // records the attempt either way.
    await client
      .from("effects")
      .update({
        error: serialise(thrown),
        lease_token: null,
        lease_until: null,
      })
      .eq("id", claimed.id)
      .eq("lease_token", claimed.lease_token);
    throw thrown;
  }
}

/** Marks an effect as permanently failed: no further attempt will be made. */
export async function abandonEffect(
  client: SupabaseClient,
  workspaceId: string,
  key: string,
  reason: unknown
): Promise<void> {
  await client
    .from("effects")
    .update({
      state: "failed",
      error: serialise(reason),
      completed_at: new Date().toISOString(),
      lease_token: null,
      lease_until: null,
    })
    .eq("workspace_id", workspaceId)
    .eq("idempotency_key", key);
}

export async function readEffect(
  client: SupabaseClient,
  workspaceId: string,
  key: string
): Promise<Effect | null> {
  const { data } = await client
    .from("effects")
    .select(
      "id, workspace_id, subject_type, subject_id, name, idempotency_key, " +
        "state, attempts, result, error, lease_token"
    )
    .eq("workspace_id", workspaceId)
    .eq("idempotency_key", key)
    .maybeSingle<Effect>();
  return data ?? null;
}

function serialise(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}
