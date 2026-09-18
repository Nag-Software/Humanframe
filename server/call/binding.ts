import type { SupabaseClient } from "@supabase/supabase-js";

import { getRuntimeSupabase } from "@/agent/lib/supabase";
import { errorFields, logger } from "@/lib/logger";
import type { CallKind } from "@/lib/plans";

/**
 * What a call is bound to.
 *
 * This is the whole security model of phase 5 in one type. It is written once,
 * server-side, from a verified Supabase session, and every later request in the
 * call — a tool call, a transcript, a hang-up — is answered from the stored row
 * rather than from anything the browser or the model says. A tool argument can
 * therefore never widen scope: there is no argument that scope is read from.
 *
 * `providerCallId` is the provider's own handle on the conversation. It is
 * internal, it is not a public identifier, and it is deliberately separate from
 * `threads.eve_session_id` — a call is not an eve session.
 */
export type CallBinding = {
  client: SupabaseClient;
  callSessionId: string;
  workspaceId: string;
  assistantId: string;
  threadId: string;
  userId: string;
  provider: CallProvider;
  providerCallId: string | null;
  status: "connecting" | "active" | "ended" | "failed";
  startedAt: string;
  kind: CallKind;
  /** The ceiling the plan decided at start; null means only the global one. */
  allowedSeconds: number | null;
};

export type CallProvider = "openai_realtime" | "tavus";

type CallSessionRow = {
  id: string;
  workspace_id: string;
  assistant_id: string;
  thread_id: string;
  user_id: string;
  provider: CallProvider;
  provider_call_id: string | null;
  status: CallBinding["status"];
  started_at: string;
  kind: CallKind;
  allowed_seconds: number | null;
};

const COLUMNS =
  "id, workspace_id, assistant_id, thread_id, user_id, provider, " +
  "provider_call_id, status, started_at, kind, allowed_seconds";

/** The service-role client the call path writes with. */
export function callClient(): SupabaseClient {
  const client = getRuntimeSupabase();
  if (!client) {
    throw new Error(
      "Call needs SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL"
    );
  }
  return client;
}

export async function createCallSession(input: {
  workspaceId: string;
  assistantId: string;
  threadId: string;
  userId: string;
  provider: CallProvider;
  model: string;
  kind?: CallKind;
  /** The plan's ceiling for this call; null means only the global one. */
  allowedSeconds?: number | null;
}): Promise<CallBinding> {
  const client = callClient();
  const { data, error } = await client
    .from("call_sessions")
    .insert({
      workspace_id: input.workspaceId,
      assistant_id: input.assistantId,
      thread_id: input.threadId,
      user_id: input.userId,
      provider: input.provider,
      model: input.model,
      kind: input.kind ?? "voice",
      allowed_seconds: input.allowedSeconds ?? null,
    })
    .select(COLUMNS)
    .single<CallSessionRow>();

  // The composite foreign keys reject an assistant or thread from another
  // workspace, so a mismatch fails here rather than becoming a leak.
  if (error || !data) {
    logger.error("call.create_session_failed", {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      ...errorFields(error),
    });
    throw new Error("Could not create call session");
  }

  return toBinding(client, data);
}

/**
 * Loads a call, and proves it belongs to the caller.
 *
 * Both the workspace and the user are part of the lookup, so a call id guessed
 * or borrowed from another tenant simply does not resolve.
 */
export async function loadCallBinding(input: {
  callSessionId: string;
  workspaceId: string;
  userId: string;
}): Promise<CallBinding | null> {
  const client = callClient();
  const { data } = await client
    .from("call_sessions")
    .select(COLUMNS)
    .eq("id", input.callSessionId)
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .maybeSingle<CallSessionRow>();

  return data ? toBinding(client, data) : null;
}

export async function attachProviderCall(
  binding: CallBinding,
  providerCallId: string
): Promise<void> {
  const { error } = await binding.client
    .from("call_sessions")
    .update({ provider_call_id: providerCallId, status: "active" })
    .eq("id", binding.callSessionId)
    .eq("workspace_id", binding.workspaceId);

  if (error) {
    logger.error("call.attach_provider_failed", {
      callSessionId: binding.callSessionId,
      ...errorFields(error),
    });
  }
}

/**
 * Ends a call. Idempotent: a browser that reports the same hang-up twice, or a
 * sweep that finds an abandoned call, does not overwrite the first reason.
 */
export type EndedCall = {
  durationMs: number;
  turnCount: number;
};

/**
 * Ends a call once. Returns what the call amounted to when this call is the
 * one that ended it, and null when it was already over — so whatever follows
 * an ending (the trace in the conversation) happens exactly once.
 */
export async function endCallSession(
  binding: CallBinding,
  reason: string,
  status: "ended" | "failed" = "ended"
): Promise<EndedCall | null> {
  const endedAt = new Date();
  const { data, error } = await binding.client
    .from("call_sessions")
    .update({ status, end_reason: reason, ended_at: endedAt.toISOString() })
    .eq("id", binding.callSessionId)
    .eq("workspace_id", binding.workspaceId)
    .in("status", ["connecting", "active"])
    .select("started_at, turn_count")
    .maybeSingle<{ started_at: string; turn_count: number }>();

  if (error) {
    logger.error("call.end_failed", {
      callSessionId: binding.callSessionId,
      ...errorFields(error),
    });
    return null;
  }
  if (!data) {
    return null;
  }
  return {
    durationMs: Math.max(0, endedAt.getTime() - new Date(data.started_at).getTime()),
    turnCount: data.turn_count,
  };
}

function toBinding(client: SupabaseClient, row: CallSessionRow): CallBinding {
  return {
    client,
    callSessionId: row.id,
    workspaceId: row.workspace_id,
    assistantId: row.assistant_id,
    threadId: row.thread_id,
    userId: row.user_id,
    provider: row.provider,
    providerCallId: row.provider_call_id,
    status: row.status,
    startedAt: row.started_at,
    kind: row.kind,
    allowedSeconds: row.allowed_seconds,
  };
}
