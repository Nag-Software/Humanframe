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
 * Composio appends `status` and `connected_account_id` to this URL, and neither
 * is evidence: anyone can craft the same request. Three things must hold before
 * a binding is written, and each rules out a different attack.
 *
 *  1. The `state` must be one we minted, unconsumed and unexpired — tying the
 *     callback to a real flow, and making it single-use so a replay binds
 *     nothing.
 *  2. The caller must still be signed in as that same user, so a state lifted
 *     from a browser history is useless in someone else's session.
 *  3. Composio must agree the account is filed under that user. Without this an
 *     attacker could pass their own `connected_account_id` and have someone
 *     else's workspace bound to a mailbox they control.
 *
 * Note the shape: every `redirect()` happens *outside* the try block. In Next,
 * `redirect()` works by throwing, so a redirect inside a `try` is caught by its
 * own `catch` — which previously turned every outcome, including the successful
 * ones, into a generic failure.
 */
type Outcome = { ok: true; provider: string } | { ok: false; reason: string };

export async function GET(req: Request) {
  if (serverEnv().CONNECTORS_ENABLED !== "true") {
    redirect(landing({ ok: false, reason: "disabled" }));
  }

  const outcome = await bind(req);
  redirect(landing(outcome));
}

async function bind(req: Request): Promise<Outcome> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const connectedAccountId = url.searchParams.get("connected_account_id");
  const status = url.searchParams.get("status");

  if (!state) {
    logger.warn("connector.callback_without_state", {});
    return { ok: false, reason: "invalid_state" };
  }

  // Consumed first, so a replay cannot get a second attempt whatever the rest
  // of the request looks like.
  const claim = await consumeAuthorizationState(state);
  if (!claim) {
    logger.warn("connector.callback_state_rejected", {});
    return { ok: false, reason: "invalid_state" };
  }

  // The session decides who is here, not the URL.
  const { getRequestScope } = await import("@/server/db/request-scope");
  const scope = await getRequestScope();

  if (
    !scope ||
    scope.userId !== claim.userId ||
    scope.workspaceId !== claim.workspaceId
  ) {
    logger.warn("connector.callback_wrong_session", { provider: claim.provider });
    return { ok: false, reason: "wrong_user" };
  }

  if (status && status !== "success") {
    return { ok: false, reason: status };
  }
  if (!connectedAccountId) {
    return { ok: false, reason: "no_account" };
  }

  try {
    // Ownership is proved by listing this user's own accounts and finding the
    // id. `connectedAccounts.get` carries no user field at all, so reading one
    // off it yields undefined — which compares unequal to every real user id,
    // rejecting every legitimate callback while proving nothing.
    const account = await readOwnedAccount({
      connectedAccountId,
      composioUserId: claim.userId,
      provider: claim.provider,
    });

    if (!account) {
      logger.warn("connector.callback_not_owned", { provider: claim.provider });
      return { ok: false, reason: "not_your_account" };
    }
    if (account.status !== "active") {
      logger.warn("connector.callback_account_not_active", {
        provider: claim.provider,
        status: account.status,
      });
      return { ok: false, reason: "not_active" };
    }
    if (account.toolkit && account.toolkit !== claim.provider) {
      return { ok: false, reason: "provider_mismatch" };
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

    return { ok: true, provider: claim.provider };
  } catch (error) {
    logger.error("connector.callback_failed", {
      provider: claim.provider,
      ...errorFields(error),
    });
    return { ok: false, reason: "bind_failed" };
  }
}

/**
 * Settings is a dialog rather than a route, so there is no `/settings/...` to
 * land on. The outcome rides on the query string of a page that does exist; the
 * dialog can read these to open itself on the right tab.
 */
function landing(outcome: Outcome): string {
  return outcome.ok
    ? `/?connector=${encodeURIComponent(outcome.provider)}&status=connected`
    : `/?connector=1&error=${encodeURIComponent(outcome.reason)}`;
}
