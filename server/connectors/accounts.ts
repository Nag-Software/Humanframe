import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getRuntimeSupabase } from "@/agent/lib/supabase";
import { errorFields, logger } from "@/lib/logger";
import type { EmailProvider } from "@/server/connectors/composio";

/**
 * Connected accounts, grants, and the OAuth state that binds a callback to the
 * person who started it.
 *
 * The rule the whole module exists to enforce: an inbox is personal. Being in
 * the same workspace grants nothing, and neither does being an assistant in it.
 * Access is a row — `connector_grants` — written by the account's owner.
 */

export type ConnectorAccount = {
  id: string;
  workspaceId: string;
  userId: string;
  provider: EmailProvider;
  composioUserId: string;
  connectedAccountId: string | null;
  accountEmail: string | null;
  status: "pending" | "active" | "expired" | "revoked" | "disconnected";
};

type AccountRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  provider: EmailProvider;
  composio_user_id: string;
  connected_account_id: string | null;
  account_email: string | null;
  status: ConnectorAccount["status"];
};

const COLUMNS =
  "id, workspace_id, user_id, provider, composio_user_id, " +
  "connected_account_id, account_email, status";

const STATE_TTL_MS = 15 * 60_000;

export function connectorClient(): SupabaseClient {
  const client = getRuntimeSupabase();
  if (!client) {
    throw new Error("Connectors need SUPABASE_SERVICE_ROLE_KEY");
  }
  return client;
}

function toAccount(row: AccountRow): ConnectorAccount {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    provider: row.provider,
    composioUserId: row.composio_user_id,
    connectedAccountId: row.connected_account_id,
    accountEmail: row.account_email,
    status: row.status,
  };
}

/**
 * Mints the state a callback must present.
 *
 * Composio appends `status` and `connected_account_id` to the redirect, and an
 * attacker can guess both. This row is the part they cannot: single-use,
 * short-lived, and tied to the signed-in user who asked.
 */
export async function beginAuthorization(input: {
  workspaceId: string;
  userId: string;
  provider: EmailProvider;
}): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const { error } = await connectorClient().from("connector_oauth_states").insert({
    state,
    workspace_id: input.workspaceId,
    user_id: input.userId,
    provider: input.provider,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });

  if (error) {
    logger.error("connector.state_insert_failed", errorFields(error));
    throw new Error("Could not start the connection");
  }
  return state;
}

export type ConsumedState = {
  workspaceId: string;
  userId: string;
  provider: EmailProvider;
};

/**
 * Consumes a state exactly once.
 *
 * The update is the check: only a row that is unconsumed and unexpired can be
 * claimed, so a replayed callback finds nothing and is refused.
 */
export async function consumeAuthorizationState(
  state: string
): Promise<ConsumedState | null> {
  const { data } = await connectorClient()
    .from("connector_oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state", state)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("workspace_id, user_id, provider")
    .maybeSingle<{ workspace_id: string; user_id: string; provider: EmailProvider }>();

  return data
    ? { workspaceId: data.workspace_id, userId: data.user_id, provider: data.provider }
    : null;
}

/** Writes the binding, once the account's ownership has been verified. */
export async function bindAccount(input: {
  workspaceId: string;
  userId: string;
  provider: EmailProvider;
  composioUserId: string;
  connectedAccountId: string;
  accountEmail: string | null;
}): Promise<ConnectorAccount> {
  const { data, error } = await connectorClient()
    .from("connector_accounts")
    .upsert(
      {
        workspace_id: input.workspaceId,
        user_id: input.userId,
        provider: input.provider,
        composio_user_id: input.composioUserId,
        connected_account_id: input.connectedAccountId,
        account_email: input.accountEmail,
        status: "active",
        connected_at: new Date().toISOString(),
        disconnected_at: null,
        last_error: null,
      },
      { onConflict: "workspace_id,provider,connected_account_id" }
    )
    .select(COLUMNS)
    .single<AccountRow>();

  if (error || !data) {
    logger.error("connector.bind_failed", {
      provider: input.provider,
      ...errorFields(error),
    });
    throw new Error("Could not save the connection");
  }
  return toAccount(data);
}

export async function listAccounts(input: {
  workspaceId: string;
  userId: string;
}): Promise<ConnectorAccount[]> {
  const { data } = await connectorClient()
    .from("connector_accounts")
    .select(COLUMNS)
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .neq("status", "disconnected")
    .returns<AccountRow[]>();

  return (data ?? []).map(toAccount);
}

/**
 * The authorised account for one assistant.
 *
 * This is the only way the tool layer gets an account id. Both halves are
 * checked in one query — the account is active and owned by this user, and the
 * assistant holds a live grant carrying the capability being asked for — so a
 * model that names an account it was never granted simply finds nothing.
 */
export async function resolveGrantedAccount(input: {
  workspaceId: string;
  userId: string;
  assistantId: string;
  capability: "read" | "send";
  provider?: EmailProvider;
  accountId?: string;
}): Promise<ConnectorAccount | null> {
  let query = connectorClient()
    .from("connector_grants")
    .select(`account_id, capabilities, connector_accounts!inner(${COLUMNS})`)
    .eq("workspace_id", input.workspaceId)
    .eq("assistant_id", input.assistantId)
    .is("revoked_at", null)
    .contains("capabilities", [input.capability])
    .eq("connector_accounts.user_id", input.userId)
    .eq("connector_accounts.status", "active");

  if (input.accountId) {
    query = query.eq("account_id", input.accountId);
  }
  if (input.provider) {
    query = query.eq("connector_accounts.provider", input.provider);
  }

  const { data } = await query.returns<
    { account_id: string; capabilities: string[]; connector_accounts: AccountRow }[]
  >();

  const row = (data ?? [])[0];
  return row ? toAccount(row.connector_accounts) : null;
}

/**
 * Disconnects. New actions stop immediately because every tool call resolves
 * the grant afresh, and any send still waiting on approval is cancelled — an
 * approval given while an account was connected is not consent to send after
 * it was taken away.
 */
export async function disconnectAccount(input: {
  workspaceId: string;
  userId: string;
  accountId: string;
}): Promise<ConnectorAccount | null> {
  const client = connectorClient();

  const { data } = await client
    .from("connector_accounts")
    .update({
      status: "disconnected",
      disconnected_at: new Date().toISOString(),
    })
    .eq("id", input.accountId)
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .select(COLUMNS)
    .maybeSingle<AccountRow>();

  if (!data) {
    return null;
  }

  await client
    .from("connector_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("account_id", input.accountId)
    .is("revoked_at", null);

  await client
    .from("email_sends")
    .update({
      status: "cancelled",
      last_error: { reason: "account_disconnected" },
    })
    .eq("account_id", input.accountId)
    .in("status", ["pending"]);

  return toAccount(data);
}
