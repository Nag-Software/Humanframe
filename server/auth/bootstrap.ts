import type { SupabaseClient } from "@supabase/supabase-js";

import { errorFields, logger } from "@/lib/logger";
import { getServiceRoleClient } from "@/lib/supabase/server";

export type BootstrapResult =
  | { ok: true; workspaceId: string | null }
  | { ok: false; code: string | null };

/**
 * Makes sure a signed-in user has a workspace, an owner membership and Maya.
 *
 * The signup trigger normally did this already. Two things go wrong in the
 * field, and both used to strand the user on the login page:
 *
 *  - the trigger did not run (an OAuth user who predates it, or a project
 *    where the migration was applied after the user existed), and
 *  - `ensure_user_bootstrap()` is missing or not executable by
 *    `authenticated` in an environment where the privileges migration did
 *    not land.
 *
 * So the user's own RPC runs first, and only if it fails is the same
 * provisioning run once more with the service role, for this user id and no
 * other. The user id comes from the verified session, never from a request.
 */
export async function ensureBootstrap(
  client: SupabaseClient,
  userId: string
): Promise<BootstrapResult> {
  const { data, error } = await client.rpc("ensure_user_bootstrap");
  if (!error) {
    return { ok: true, workspaceId: typeof data === "string" ? data : null };
  }

  logger.error("auth.bootstrap_rpc_failed", errorFields(error));

  let admin: SupabaseClient;
  try {
    admin = getServiceRoleClient();
  } catch {
    return { ok: false, code: error.code ?? null };
  }

  const fallback = await admin.rpc("provision_user", { target_user: userId });
  if (fallback.error) {
    logger.error("auth.bootstrap_fallback_failed", errorFields(fallback.error));
    return { ok: false, code: fallback.error.code ?? error.code ?? null };
  }

  logger.info("auth.bootstrap_recovered");
  return {
    ok: true,
    workspaceId: typeof fallback.data === "string" ? fallback.data : null,
  };
}
