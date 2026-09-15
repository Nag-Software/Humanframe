import { Composio } from "@composio/core";

import { serverEnv } from "@/lib/env";

/**
 * The Composio seam.
 *
 * Everything that knows Composio's API lives here, for the same reason the
 * OpenAI Realtime adapter is one file: the rest of the connector code is
 * written against Humanframe's own vocabulary, so a second provider — or a
 * different broker entirely — does not ripple outward.
 *
 * Two things this module refuses to do:
 *
 *  - take a user id from anything but a verified server-side session. Composio
 *    partitions connected accounts by the subject we hand it, so a caller who
 *    could choose that string could read someone else's inbox.
 *  - use the default auth configs. Composio's managed Gmail config requests
 *    `https://mail.google.com/` — full mailbox control including permanent
 *    deletion — plus contacts, birthdays and phone numbers; Outlook's adds
 *    calendar, chat and mailbox-settings writes. We expose search, read and
 *    send, so we register our own configs and name them explicitly.
 */

export type EmailProvider = "gmail" | "outlook";

/** Verified against the live API on 2026-09-15; argument names are theirs. */
export const PROVIDER_TOOLS = {
  gmail: {
    search: "GMAIL_FETCH_EMAILS",
    thread: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    send: "GMAIL_SEND_EMAIL",
  },
  outlook: {
    // Deliberately LIST, not OUTLOOK_SEARCH_MESSAGES. Measured on 2026-09-15:
    // the search tool refuses personal accounts outright ("Search does not work
    // with @hotmail.com or @outlook.com personal accounts"), while LIST with a
    // `search` term works on both personal and Microsoft 365 mailboxes. Since
    // Humanframe supports personal accounts, the tool that works everywhere is
    // the one we ship; the other stays allowlisted for work/school tenants.
    search: "OUTLOOK_LIST_MESSAGES",
    searchWorkAccountOnly: "OUTLOOK_SEARCH_MESSAGES",
    thread: "OUTLOOK_GET_MESSAGE",
    send: "OUTLOOK_SEND_EMAIL",
  },
} as const satisfies Record<EmailProvider, Record<string, string>>;

/**
 * The scopes each provider's auth config is pinned to.
 *
 * Documented here rather than only in Composio's dashboard, because the whole
 * point is that they are narrower than the defaults and someone will
 * eventually wonder why.
 */
export const PROVIDER_SCOPES = {
  gmail: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
  outlook: ["Mail.Read", "Mail.Send", "User.Read", "offline_access"],
} as const satisfies Record<EmailProvider, readonly string[]>;

let cached: Composio | null = null;

export function composioClient(): Composio {
  const env = serverEnv();
  if (!env.COMPOSIO_API_KEY) {
    throw new Error("COMPOSIO_API_KEY is required for email connectors");
  }
  cached ??= new Composio({ apiKey: env.COMPOSIO_API_KEY });
  return cached;
}

/** The auth config to connect through. Fails closed rather than falling back. */
export function authConfigFor(provider: EmailProvider): string {
  const env = serverEnv();
  const id =
    provider === "gmail"
      ? env.COMPOSIO_GMAIL_AUTH_CONFIG_ID
      : env.COMPOSIO_OUTLOOK_AUTH_CONFIG_ID;

  if (!id) {
    // Without an explicit config Composio would use its own default, which
    // asks for far more than we expose. Refusing is the safe direction.
    throw new Error(
      `No auth config for ${provider}. Set COMPOSIO_${provider.toUpperCase()}_AUTH_CONFIG_ID ` +
        `to a config pinned to: ${PROVIDER_SCOPES[provider].join(", ")}`
    );
  }
  return id;
}

export type AuthorizationOutcome =
  | { kind: "link"; redirectUrl: string; connectionRequestId: string }
  /** Already connected: there is nothing to authorise, so no link is minted. */
  | { kind: "already_connected"; connectedAccountId: string; email: string | null };

/**
 * Starts an OAuth round for one Humanframe user.
 *
 * `composioUserId` is the Humanframe user id, taken from the session — never
 * from a request body or a model argument.
 *
 * Two other call shapes look right and are not, both verified against the live
 * API on 2026-09-15:
 *
 *  - `connectedAccounts.initiate()` is retired. The API answers
 *    `ConnectedAccountsEndpointRetired` for Composio-managed auth configs and
 *    names this endpoint as its replacement.
 *  - `session.authorize(toolkit, { authConfigId })` ignores `authConfigId` —
 *    it is not in that method's options — and silently auto-creates a default
 *    config instead, which asks for every scope Composio's default requests.
 *    That is how a "least privilege" connection quietly becomes full mailbox
 *    access, so the config is passed positionally here, where it is required.
 */
export async function createAuthorizationLink(input: {
  provider: EmailProvider;
  composioUserId: string;
  callbackUrl: string;
}): Promise<AuthorizationOutcome> {
  const existing = await listUserAccounts(input.composioUserId, input.provider).catch(
    () => [] as RawAccount[]
  );

  // Already connected: minting another link would ask the user to authorise
  // something they already authorised, and Composio refuses a second account
  // under the same auth config anyway.
  const live = existing.find((account) =>
    LIVE.has(String(account.status ?? "").toLowerCase())
  );
  if (live?.id) {
    return {
      kind: "already_connected",
      connectedAccountId: live.id,
      email: readEmail(live.data),
    };
  }

  // Every authorisation round that is abandoned — a link never opened, a
  // consent screen closed — leaves a dead row behind, and Composio counts those
  // when it decides whether a second account exists. Left alone, two abandoned
  // attempts make the third fail with `MultipleConnectedAccounts` and the user
  // simply cannot connect. So the dead ones are cleared first.
  await Promise.all(
    existing
      .filter((account) => DEAD.has(String(account.status ?? "").toLowerCase()))
      .map((account) =>
        account.id
          ? composioClient().connectedAccounts.delete(account.id).catch(() => undefined)
          : undefined
      )
  );

  const request = (await composioClient().connectedAccounts.link(
    input.composioUserId,
    authConfigFor(input.provider),
    { callbackUrl: input.callbackUrl }
  )) as { id?: string; redirectUrl?: string };

  if (!request.redirectUrl) {
    throw new Error(`Composio returned no redirect URL for ${input.provider}`);
  }

  return {
    kind: "link",
    redirectUrl: request.redirectUrl,
    connectionRequestId: request.id ?? "",
  };
}

export type ConnectedAccountFacts = {
  id: string;
  toolkit: string;
  status: string;
  email: string | null;
};

/** Live states. Anything else is a dead connection request, not an account. */
const LIVE = new Set(["active"]);
const DEAD = new Set(["initiated", "initializing", "expired", "failed", "inactive"]);

type RawAccount = {
  id?: string;
  status?: string;
  userId?: string;
  toolkit?: { slug?: string };
  data?: Record<string, unknown>;
};

/**
 * Every account Composio has filed under this user, for one toolkit.
 *
 * The scoping is the `userIds` filter, applied server-side by Composio — not a
 * field comparison here. List items in this SDK version carry no user field at
 * all, so re-filtering on one silently matches nothing and every ownership
 * check fails closed against legitimate callers.
 *
 * Measured on 2026-09-15 before relying on it: unfiltered returns 10 accounts,
 * this user returns exactly theirs, and a nonexistent user returns none. The
 * filter is enforced rather than ignored, so membership in this list is a
 * sound ownership proof.
 */
async function listUserAccounts(
  composioUserId: string,
  provider: EmailProvider
): Promise<RawAccount[]> {
  const page = (await composioClient().connectedAccounts.list({
    userIds: [composioUserId],
    toolkitSlugs: [provider],
  } as never)) as { items?: RawAccount[] };

  return page.items ?? [];
}

/**
 * Proves an account belongs to a user, and reads back what Composio believes
 * about it.
 *
 * The ownership half is the point. Composio appends `status` and
 * `connected_account_id` to the callback and neither proves who authorised it,
 * so without this an attacker could pass their own account id and have someone
 * else's workspace bound to a mailbox they control.
 *
 * It is done by listing the user's own accounts and looking for this id, not by
 * fetching the account and reading a user field off it: `connectedAccounts.get`
 * returns no user field at all. Reading one off that response yields `undefined`
 * — which compares unequal to every real user id, so the check would reject
 * every legitimate callback while proving nothing. `list` is the shape that
 * actually carries the subject.
 */
export async function readOwnedAccount(input: {
  connectedAccountId: string;
  composioUserId: string;
  provider: EmailProvider;
}): Promise<ConnectedAccountFacts | null> {
  const owned = await listUserAccounts(input.composioUserId, input.provider).catch(
    () => [] as RawAccount[]
  );

  const account = owned.find((item) => item.id === input.connectedAccountId);
  if (!account?.id) {
    return null;
  }

  return {
    id: account.id,
    toolkit: account.toolkit?.slug ?? "",
    status: String(account.status ?? "").toLowerCase(),
    email: readEmail(account.data),
  };
}

function readEmail(data: Record<string, unknown> | undefined): string | null {
  for (const key of ["email", "user_email", "mail", "userPrincipalName"]) {
    const value = data?.[key];
    if (typeof value === "string" && value.includes("@")) {
      return value;
    }
  }
  return null;
}

/**
 * Runs one provider tool for one user.
 *
 * The caller has already proved the account belongs to this user and that the
 * assistant holds a live grant for it; this just carries the call across the
 * seam. Arguments are built by our own typed layer, never handed through from
 * a model.
 */
export async function executeProviderTool(input: {
  composioUserId: string;
  connectedAccountId: string;
  slug: string;
  version: string;
  args: Record<string, unknown>;
}): Promise<unknown> {
  // Composio refuses a manual execution without an explicit toolkit version,
  // and that is the right default: a toolkit that changes shape underneath a
  // pinned action is exactly the drift the register exists to catch. An
  // unpinned row is a configuration error, not something to paper over by
  // silently taking the newest version.
  if (!input.version || input.version === "unpinned") {
    throw new Error(
      `No toolkit version pinned for ${input.slug}. Set connector_actions.tool_version.`
    );
  }

  // `tools.execute`, not `session.execute`. The session API routes through
  // Composio's Tool Router, which manages connection selection itself and
  // ignores an account passed alongside the arguments — it answers
  // `ToolRouterV2_NoActiveConnection` even when the account is active, because
  // it is looking at its own session state rather than at ours.
  //
  // Here the account is part of the request body, which is what makes the
  // choice explicit. That matters beyond fixing the error: the whole design
  // says the account is chosen by Humanframe from a verified grant, never by
  // the provider picking "the last connected one".
  const response = (await composioClient().tools.execute(input.slug, {
    userId: input.composioUserId,
    connectedAccountId: input.connectedAccountId,
    version: input.version,
    arguments: input.args,
  })) as { data?: unknown; error?: string | null; successful?: boolean };

  if (response.successful === false) {
    throw new Error(response.error ?? "The provider rejected the call");
  }

  return response.data ?? response;
}

/** The toolkit versions Composio currently offers, newest first. */
export async function availableToolkitVersions(
  provider: EmailProvider
): Promise<string[]> {
  const toolkit = (await composioClient().toolkits.get(provider)) as {
    meta?: { availableVersions?: string[] };
  };
  return toolkit.meta?.availableVersions ?? [];
}

/** Revokes at the broker, so disconnecting is not merely a local flag. */
export async function revokeConnectedAccount(
  connectedAccountId: string
): Promise<void> {
  await composioClient().connectedAccounts.delete(connectedAccountId);
}
