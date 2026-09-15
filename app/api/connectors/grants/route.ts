import { z } from "zod";

import { serverEnv } from "@/lib/env";
import { errorFields, logger } from "@/lib/logger";
import { connectorClient } from "@/server/connectors/accounts";
import { getRequestScope } from "@/server/db/request-scope";

/**
 * What an assistant may do with a connected mailbox.
 *
 * Connecting an account grants nothing on its own — that is the whole design —
 * so without this route a connected mailbox is inert and the assistant has no
 * way to be given access to it.
 *
 * Only the account's **owner** may write here, and ownership is re-checked
 * against the session on every call. A workspace admin cannot grant an
 * assistant access to a colleague's inbox, because membership was never the
 * thing that conferred access.
 */
const bodySchema = z.object({
  accountId: z.uuid(),
  assistantId: z.uuid(),
  // 'send' is deliberately allowed here, but an action still has to be enabled
  // in the register and carry an approval policy before anything can be sent.
  capabilities: z.array(z.enum(["read", "send"])),
});

/** The caller's own accounts, their grants, and what each account supports. */
export async function GET() {
  if (serverEnv().CONNECTORS_ENABLED !== "true") {
    return Response.json({ error: "Connectors are not enabled" }, { status: 404 });
  }

  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = connectorClient();

  const { data: accounts } = await client
    .from("connector_accounts")
    .select("id, provider, account_email, status")
    .eq("workspace_id", scope.workspaceId)
    .eq("user_id", scope.userId)
    .neq("status", "disconnected")
    .returns<
      { id: string; provider: string; account_email: string | null; status: string }[]
    >();

  const ids = (accounts ?? []).map((a) => a.id);

  const { data: grants } = ids.length
    ? await client
        .from("connector_grants")
        .select("id, account_id, assistant_id, capabilities")
        .in("account_id", ids)
        .is("revoked_at", null)
        .returns<
          { id: string; account_id: string; assistant_id: string; capabilities: string[] }[]
        >()
    : { data: [] };

  // What the register actually supports today, so the UI can show which
  // actions a capability unlocks rather than promising more than we ship.
  const { data: actions } = await client
    .from("connector_actions")
    .select("action_key, provider, capability, risk, enabled")
    .eq("enabled", true)
    .returns<
      { action_key: string; provider: string; capability: string; risk: string }[]
    >();

  return Response.json({
    accounts: accounts ?? [],
    grants: grants ?? [],
    supportedActions: actions ?? [],
  });
}

export async function POST(req: Request) {
  if (serverEnv().CONNECTORS_ENABLED !== "true") {
    return Response.json({ error: "Connectors are not enabled" }, { status: 404 });
  }

  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const client = connectorClient();

  // Ownership, re-derived. The account must be this user's, in this workspace,
  // and still connected — a grant on a dead account would be a grant that
  // silently comes back to life if it were ever reconnected.
  const { data: account } = await client
    .from("connector_accounts")
    .select("id, status")
    .eq("id", parsed.data.accountId)
    .eq("workspace_id", scope.workspaceId)
    .eq("user_id", scope.userId)
    .maybeSingle<{ id: string; status: string }>();

  if (!account || account.status !== "active") {
    return Response.json({ error: "Unknown account" }, { status: 404 });
  }

  // The assistant must belong to the same workspace.
  const { data: assistant } = await client
    .from("assistants")
    .select("id")
    .eq("id", parsed.data.assistantId)
    .eq("workspace_id", scope.workspaceId)
    .maybeSingle<{ id: string }>();

  if (!assistant) {
    return Response.json({ error: "Unknown assistant" }, { status: 404 });
  }

  // An empty capability list is how access is withdrawn.
  if (parsed.data.capabilities.length === 0) {
    const { error } = await client
      .from("connector_grants")
      .update({ revoked_at: new Date().toISOString() })
      .eq("account_id", account.id)
      .eq("assistant_id", assistant.id)
      .is("revoked_at", null);

    if (error) {
      logger.error("connector.revoke_failed", errorFields(error));
      return Response.json({ error: "Could not update access" }, { status: 500 });
    }

    logger.info("connector.grant_revoked", {
      workspaceId: scope.workspaceId,
      assistantId: assistant.id,
    });
    return Response.json({ capabilities: [] });
  }

  // Revoke then insert rather than update in place: a grant is the record of a
  // decision, so changing one leaves the old decision visible in history.
  await client
    .from("connector_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("account_id", account.id)
    .eq("assistant_id", assistant.id)
    .is("revoked_at", null);

  const { error } = await client.from("connector_grants").insert({
    workspace_id: scope.workspaceId,
    account_id: account.id,
    assistant_id: assistant.id,
    capabilities: parsed.data.capabilities,
    granted_by: scope.userId,
  });

  if (error) {
    logger.error("connector.grant_failed", errorFields(error));
    return Response.json({ error: "Could not update access" }, { status: 500 });
  }

  logger.info("connector.grant_updated", {
    workspaceId: scope.workspaceId,
    assistantId: assistant.id,
    capabilities: parsed.data.capabilities,
  });

  return Response.json({ capabilities: parsed.data.capabilities });
}
