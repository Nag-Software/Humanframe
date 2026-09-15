import { connectorClient } from "@/server/connectors/accounts";

/**
 * What this caller may see.
 *
 * Discovery is an intersection, and every term is required:
 *
 *  1. the action is enabled in Humanframe's register;
 *  2. its adapter and renderer exist in *this* build;
 *  3. the account is connected and active, and owned by this user;
 *  4. this assistant holds a live grant carrying the action's capability.
 *
 * Composio's catalogue is not a term. An action being available there means
 * "available for consideration", never "permitted" — and a tool's name, its
 * description, or a hint tag from the provider grants nothing.
 */
export type DiscoveredAction = {
  actionKey: string;
  provider: string;
  accountId: string;
  accountEmail: string | null;
  capability: "read" | "send";
  risk: "read" | "side_effect";
  /** The name the model sees. Namespaced, because dynamic keys are bare. */
  toolName: string;
  description: string;
};

type Row = {
  account_id: string;
  capabilities: string[];
  connector_accounts: {
    id: string;
    provider: string;
    status: string;
    account_email: string | null;
    user_id: string;
  };
};

type ActionRow = {
  action_key: string;
  provider: string;
  capability: "read" | "send";
  risk: "read" | "side_effect";
  normalizer: string;
  renderer: string;
  enabled: boolean;
};

/** Adapters and renderers compiled into this build. An unknown name is dead. */
import { hasNormalizer } from "@/server/connectors/normalizers";
import { hasRenderer } from "@/server/connectors/renderers";

const DESCRIPTIONS: Record<string, string> = {
  "email.search":
    "Search this mailbox for messages. Read-only. Returns a bounded list of " +
    "headers and short snippets, never whole mailboxes.",
  "email.read":
    "Read one message thread from this mailbox by its id. Read-only.",
  "email.send":
    "Send a prepared email from this mailbox. This asks the user to approve " +
    "the exact message first, and cannot send without that approval.",
};

export async function discoverActions(input: {
  workspaceId: string;
  userId: string;
  assistantId: string;
}): Promise<DiscoveredAction[]> {
  const client = connectorClient();

  const { data: grants } = await client
    .from("connector_grants")
    .select(
      "account_id, capabilities, " +
        "connector_accounts!inner(id, provider, status, account_email, user_id)"
    )
    .eq("workspace_id", input.workspaceId)
    .eq("assistant_id", input.assistantId)
    .is("revoked_at", null)
    .eq("connector_accounts.user_id", input.userId)
    .eq("connector_accounts.status", "active")
    .returns<Row[]>();

  if (!grants || grants.length === 0) {
    return [];
  }

  const { data: actions } = await client
    .from("connector_actions")
    .select("action_key, provider, capability, risk, normalizer, renderer, enabled")
    .eq("enabled", true)
    .returns<ActionRow[]>();

  if (!actions || actions.length === 0) {
    return [];
  }

  const discovered: DiscoveredAction[] = [];

  for (const grant of grants) {
    const account = grant.connector_accounts;

    for (const action of actions) {
      if (action.provider !== account.provider) continue;
      if (!grant.capabilities.includes(action.capability)) continue;

      // A row may name an adapter this build does not have — after a rollback,
      // say. Discovering it would mean offering the model something that can
      // only fail, so it is simply not offered.
      if (!hasNormalizer(action.normalizer) || !hasRenderer(action.renderer)) {
        continue;
      }

      discovered.push({
        actionKey: action.action_key,
        provider: account.provider,
        accountId: account.id,
        accountEmail: account.account_email,
        capability: action.capability,
        risk: action.risk,
        // Bare keys collide across accounts, so the account is in the name.
        // This is also how the model picks an account explicitly rather than
        // us guessing "the last connected one".
        toolName: toolNameFor(action.action_key, account.provider),
        description:
          (DESCRIPTIONS[action.action_key] ?? action.action_key) +
          ` Account: ${account.account_email ?? account.provider}.`,
      });
    }
  }

  return discovered;
}

/** `email.search` + gmail -> `gmail__email_search`. */
export function toolNameFor(actionKey: string, provider: string): string {
  return `${provider}__${actionKey.replace(/\./g, "_")}`;
}
