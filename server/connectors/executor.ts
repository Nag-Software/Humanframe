import { createHash } from "node:crypto";

import { logger } from "@/lib/logger";
import { connectorClient } from "@/server/connectors/accounts";
import {
  PROVIDER_TOOLS,
  executeProviderTool,
  type EmailProvider,
} from "@/server/connectors/composio";
import { normalize } from "@/server/connectors/normalizers";
import { FALLBACK_RENDERER, hasRenderer } from "@/server/connectors/renderers";
import { toPlainText } from "@/server/connectors/normalizers";

/**
 * The only way a provider call happens.
 *
 * Discovery decided what the model could ask for. This decides what actually
 * runs, and it re-derives every term rather than trusting any of them:
 *
 *  - the register row, read now, so a disabled action stops working at once;
 *  - the account, read now, so a disconnected one stops working at once;
 *  - the grant, read now, so a capability removed after discovery stops working
 *    — including on a resumed workflow, where the discovery that authorised the
 *    call may be hours old;
 *  - the arguments, built here from a typed shape, never passed through.
 *
 * Any lookup failure is a refusal, never a fallback to permissive behaviour.
 */

export const ACTION_VERSION = "1";
const ACTION_TTL_MS = 30 * 60_000;

export type ActionArgs = {
  query?: string | null;
  threadId?: string | null;
  to?: string[] | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  subject?: string | null;
  body?: string | null;
  limit?: number | null;
};

export type ActionOutcome =
  | { ok: true; renderer: string; result: unknown }
  | { ok: true; awaitingApproval: true; renderer: string; actionId: string; preview: unknown }
  | { ok: false; error: string };

type RegisterRow = {
  action_key: string;
  provider: EmailProvider;
  tool_slug: string;
  tool_version: string;
  schema_hash: string;
  capability: "read" | "send";
  risk: "read" | "side_effect";
  approval_policy: "none" | "always";
  normalizer: string;
  result_version: string;
  renderer: string;
  enabled: boolean;
};

/** The whole authorization check, re-run from scratch. */
async function authorize(input: {
  actionKey: string;
  accountId: string;
}): Promise<
  | { ok: true; action: RegisterRow; account: { id: string; provider: EmailProvider; userId: string; workspaceId: string; assistantIds: string[] } }
  | { ok: false; error: string }
> {
  const client = connectorClient();

  const { data: account } = await client
    .from("connector_accounts")
    .select("id, provider, user_id, workspace_id, status")
    .eq("id", input.accountId)
    .maybeSingle<{
      id: string;
      provider: EmailProvider;
      user_id: string;
      workspace_id: string;
      status: string;
    }>();

  if (!account || account.status !== "active") {
    return { ok: false, error: "That mailbox is not connected." };
  }

  const { data: action } = await client
    .from("connector_actions")
    .select(
      "action_key, provider, tool_slug, tool_version, schema_hash, capability, " +
        "risk, approval_policy, normalizer, result_version, renderer, enabled"
    )
    .eq("action_key", input.actionKey)
    .eq("provider", account.provider)
    .maybeSingle<RegisterRow>();

  // An action absent from the register, or disabled, is not executable —
  // including one the model learned about in an earlier session.
  if (!action || !action.enabled) {
    return { ok: false, error: "That action is not available." };
  }

  const { data: grants } = await client
    .from("connector_grants")
    .select("assistant_id, capabilities")
    .eq("account_id", account.id)
    .is("revoked_at", null)
    .contains("capabilities", [action.capability])
    .returns<{ assistant_id: string; capabilities: string[] }[]>();

  if (!grants || grants.length === 0) {
    return { ok: false, error: "This assistant no longer has access to that mailbox." };
  }

  return {
    ok: true,
    action,
    account: {
      id: account.id,
      provider: account.provider,
      userId: account.user_id,
      workspaceId: account.workspace_id,
      assistantIds: grants.map((g) => g.assistant_id),
    },
  };
}

/**
 * Builds the provider arguments.
 *
 * Arguments are constructed here from a narrow typed shape, so a model cannot
 * smuggle an extra provider parameter through — `user_id`, say, which on both
 * providers selects whose mailbox is touched.
 */
function buildArgs(
  action: RegisterRow,
  args: ActionArgs
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 25);

  if (action.action_key === "email.search") {
    const query = (args.query ?? "").trim().slice(0, 400);
    return action.provider === "gmail"
      ? { ok: true, value: { query, max_results: limit } }
      : { ok: true, value: { query, size: limit } };
  }

  if (action.action_key === "email.read") {
    const id = (args.threadId ?? "").trim();
    if (!id) return { ok: false, error: "No thread id was given." };
    return action.provider === "gmail"
      ? { ok: true, value: { thread_id: id } }
      : { ok: true, value: { message_id: id } };
  }

  if (action.action_key === "email.send") {
    const to = (args.to ?? []).map((a) => a.trim()).filter(Boolean);
    const subject = (args.subject ?? "").trim();
    const body = args.body ?? "";

    // An ambiguous recipient is a question for the user, not a guess.
    if (to.length === 0) return { ok: false, error: "No recipient was given." };
    if (!subject) return { ok: false, error: "No subject was given." };
    if (!body.trim()) return { ok: false, error: "The message body is empty." };

    return action.provider === "gmail"
      ? {
          ok: true,
          value: {
            recipient_email: to[0],
            extra_recipients: to.slice(1),
            cc: args.cc ?? [],
            bcc: args.bcc ?? [],
            subject,
            body,
            is_html: false,
          },
        }
      : {
          ok: true,
          value: {
            to: to[0],
            cc_emails: to.length > 1 ? [...to.slice(1), ...(args.cc ?? [])] : args.cc ?? [],
            bcc_emails: args.bcc ?? [],
            subject,
            body,
            is_html: false,
          },
        };
  }

  return { ok: false, error: `Unsupported action: ${action.action_key}` };
}

/**
 * Canonical JSON: object keys sorted, recursively.
 *
 * The payload is hashed in JavaScript, stored as `jsonb`, and read back before
 * every send to prove it has not moved. Postgres does not preserve key order in
 * `jsonb`, so hashing `JSON.stringify` output directly would produce a hash
 * that never matches on the way back — and a payload check that never matches
 * is a payload check that gets removed. Sorting makes the hash a property of
 * the content rather than of the insertion order.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(payload)))
    .digest("hex");
}

/**
 * Runs one action.
 *
 * A read executes immediately. A side effect never does: it is written as an
 * immutable action record and handed to the approval path, so what a person
 * later approves is a stored row — not a fresh set of model arguments.
 */
export async function runAction(input: {
  actionKey: string;
  accountId: string;
  args: ActionArgs;
  callId: string;
  sessionId: string;
}): Promise<ActionOutcome> {
  const auth = await authorize(input);
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }

  const { action, account } = auth;
  const built = buildArgs(action, input.args);
  if (!built.ok) {
    return { ok: false, error: built.error };
  }

  // The slug comes from the register, but it must also be one this build knows
  // how to call. A register row naming an arbitrary provider tool is refused.
  const known = Object.values(PROVIDER_TOOLS[action.provider]) as string[];
  if (!known.includes(action.tool_slug)) {
    logger.error("connector.unknown_tool_slug", {
      actionKey: action.action_key,
      provider: action.provider,
    });
    return { ok: false, error: "That action is not available." };
  }

  if (action.risk === "side_effect" || action.approval_policy === "always") {
    return stageForApproval({
      action,
      account,
      payload: built.value,
      callId: input.callId,
    });
  }

  return executeNow({ action, account, payload: built.value });
}

async function executeNow(input: {
  action: RegisterRow;
  account: { id: string; provider: EmailProvider; userId: string; workspaceId: string };
  payload: Record<string, unknown>;
}): Promise<ActionOutcome> {
  const { action, account, payload } = input;

  let raw: unknown;
  try {
    raw = await executeProviderTool({
      composioUserId: account.userId,
      connectedAccountId: await connectedAccountIdFor(account.id),
      slug: action.tool_slug,
      args: payload,
    });
  } catch (error) {
    logger.error("connector.provider_call_failed", {
      actionKey: action.action_key,
      provider: action.provider,
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "The mail provider could not complete that." };
  }

  const normalized = normalize(action.normalizer, raw);

  if (!normalized.ok) {
    // A read that will not normalise still has something to show, but only as
    // sanitized text in a clearly limited card — never raw provider JSON.
    logger.warn("connector.normalize_failed", {
      actionKey: action.action_key,
      error: normalized.error,
    });
    return {
      ok: true,
      renderer: FALLBACK_RENDERER,
      result: {
        version: "connector.fallback.v1",
        actionKey: action.action_key,
        text: toPlainText(JSON.stringify(raw)).slice(0, 2000),
      },
    };
  }

  const renderer = hasRenderer(action.renderer) ? action.renderer : FALLBACK_RENDERER;
  return { ok: true, renderer, result: normalized.value };
}

/**
 * Freezes a side effect for a person to decide on.
 *
 * The record carries the exact account, the exact payload and its hash, and
 * the versions in force when it was made. Nothing about it can drift: a
 * different recipient, body or account produces a different hash and therefore
 * a different record, which needs its own approval.
 */
async function stageForApproval(input: {
  action: RegisterRow;
  account: { id: string; provider: EmailProvider; userId: string; workspaceId: string; assistantIds: string[] };
  payload: Record<string, unknown>;
  callId: string;
}): Promise<ActionOutcome> {
  const { action, account, payload } = input;

  // Without a complete, correct preview there is nothing to approve, so the
  // action is blocked rather than shown as raw JSON.
  if (!hasRenderer(action.renderer) || action.renderer === FALLBACK_RENDERER) {
    return { ok: false, error: "That action cannot be previewed, so it is blocked." };
  }

  const payloadHash = hashPayload(payload);

  const { data, error } = await connectorClient()
    .from("connector_action_records")
    .insert({
      workspace_id: account.workspaceId,
      account_id: account.id,
      assistant_id: account.assistantIds[0],
      action_key: action.action_key,
      provider: action.provider,
      tool_slug: action.tool_slug,
      tool_version: action.tool_version,
      schema_hash: action.schema_hash,
      action_version: ACTION_VERSION,
      payload,
      payload_hash: payloadHash,
      approval_call_id: input.callId,
      expires_at: new Date(Date.now() + ACTION_TTL_MS).toISOString(),
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !data) {
    logger.error("connector.stage_failed", {
      actionKey: action.action_key,
      message: error?.message,
    });
    return { ok: false, error: "Could not prepare that action." };
  }

  return {
    ok: true,
    awaitingApproval: true,
    renderer: action.renderer,
    actionId: data.id,
    preview: {
      version: "email.draft.v1",
      account: account.provider,
      to: payload.recipient_email ?? payload.to,
      cc: payload.cc ?? payload.cc_emails ?? [],
      bcc: payload.bcc ?? payload.bcc_emails ?? [],
      subject: payload.subject,
      body: payload.body,
    },
  };
}

async function connectedAccountIdFor(accountId: string): Promise<string> {
  const { data } = await connectorClient()
    .from("connector_accounts")
    .select("connected_account_id")
    .eq("id", accountId)
    .maybeSingle<{ connected_account_id: string | null }>();

  if (!data?.connected_account_id) {
    throw new Error("Account has no provider connection");
  }
  return data.connected_account_id;
}
