import { redirect } from "next/navigation";

import { serverEnv } from "@/lib/env";
import { errorFields, logger } from "@/lib/logger";
import {
  bindAccount,
  consumeAuthorizationState,
} from "@/server/connectors/accounts";
import { readOwnedAccount } from "@/server/connectors/composio";

/**
 * Where an OAuth round lands.
 *
 * Composio appends `status` and `connected_account_id` to this URL, and
 * neither is evidence: anyone can craft the same request. Three things must
 * hold before a binding is written, and each rules out a different attack.
 *
 *  1. The `state` must be one we minted, unconsumed and unexpired. That ties
 *     the callback to a real flow started by a signed-in user, and makes it
 *     single-use so a replay binds nothing.
 *  2. The caller must still be signed in as that same user. A state stolen
 *     from a browser history is useless in someone else's session.
 *  3. Composio must list that account under this user, and it must be active.
 *     Without this an attacker could pass their own `connected_account_id` and
 *     have someone else's workspace bound to a mailbox they control.
 */
export async function GET(req: Request) {
  if (serverEnv().CONNECTORS_ENABLED !== "true") {
    redirect("/settings/connections?error=disabled");
  }

  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const connectedAccountId = url.searchParams.get("connected_account_id");
  const status = url.searchParams.get("status");

  if (!state) {
    logger.warn("connector.callback_without_state", {});
    redirect("/settings/connections?error=invalid_state");
  }

  // Consuming first means a replay cannot get a second attempt, whatever the
  // rest of the request looks like.
  const claim = await consumeAuthorizationState(state);
  if (!claim) {
    logger.warn("connector.callback_state_rejected", {});
    redirect("/settings/connections?error=invalid_state");
  }

  // The session, not the URL, says who is here. Imported lazily so the check
  // runs against this request's own cookies.
  const { getRequestScope } = await import("@/server/db/request-scope");
  const scope = await getRequestScope();

  if (!scope || scope.userId !== claim.userId || scope.workspaceId !== claim.workspaceId) {
    logger.warn("connector.callback_wrong_session", { provider: claim.provider });
    redirect("/settings/connections?error=wrong_user");
  }

  if (status && status !== "success") {
    redirect(`/settings/connections?error=${encodeURIComponent(status)}`);
  }

  if (!connectedAccountId) {
    redirect("/settings/connections?error=no_account");
  }

  try {
    // Ownership is proved by listing this user's accounts and finding the
    // id — `connectedAccounts.get` carries no user field, so a fetch-by-id
    // cannot tell us who authorised it.
    const account = await readOwnedAccount({
      connectedAccountId,
      composioUserId: claim.userId,
      provider: claim.provider,
    });

    if (!account || account.status !== "active") {
      logger.warn("connector.callback_account_not_active", {
        provider: claim.provider,
        status: account?.status ?? "missing",
      });
      redirect("/settings/connections?error=not_active");
    }

    if (account.toolkit && account.toolkit !== claim.provider) {
      redirect("/settings/connections?error=provider_mismatch");
    }

    await bindAccount({
      workspaceId: claim.workspaceId,
      userId: claim.userId,
      provider: claim.provider,
      composioUserId: claim.userId,
      connectedAccountId: account.id,
      accountEmail: account.email,
    });

    logger.info("connector.connected", {
      workspaceId: claim.workspaceId,
      provider: claim.provider,
    });
  } catch (error) {
    logger.error("connector.callback_failed", {
      provider: claim.provider,
      ...errorFields(error),
    });
    redirect("/settings/connections?error=bind_failed");
  }

  redirect(`/settings/connections?connected=${claim.provider}`);
}
