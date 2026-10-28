import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureBootstrap } from "@/server/auth/bootstrap";
import type { ThreadScope } from "@/server/db/repositories/threads";
import {
  getActiveWorkspace,
  type Workspace,
} from "@/server/db/repositories/workspaces";

export type RequestScope = ThreadScope & {
  workspace: Workspace;
  email: string | null;
  userName: string | null;
};

/**
 * Resolves the signed-in user and their workspace once per request. Returns
 * null when there is no session, so API routes can answer 401 instead of
 * redirecting.
 */
export async function getRequestScope(): Promise<RequestScope | null> {
  const client = await createSupabaseServerClient();
  const {
    data: { user },
  } = await client.auth.getUser();

  if (!user) {
    return null;
  }

  let workspace = await getActiveWorkspace(client, user.id);
  if (!workspace) {
    // A session without a workspace is a sign-in that never finished
    // provisioning. Converge here rather than treat the user as signed out.
    const bootstrap = await ensureBootstrap(client, user.id);
    if (bootstrap.ok) {
      workspace = await getActiveWorkspace(client, user.id);
    }
  }
  if (!workspace) {
    return null;
  }

  const userName =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    null;

  return {
    client,
    userId: user.id,
    email: user.email ?? null,
    userName,
    workspaceId: workspace.id,
    workspace,
  };
}

/** Page-side variant: sends the visitor to /login when there is no session. */
export async function requireRequestScope(): Promise<RequestScope> {
  const scope = await getRequestScope();
  if (!scope) {
    // Signed in but unprovisioned gets the explanation, not a bare /login
    // that the proxy would bounce straight back here.
    const client = await createSupabaseServerClient();
    const {
      data: { user },
    } = await client.auth.getUser();
    redirect(user ? "/login?error=bootstrap" : "/login");
  }
  return scope;
}
