import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";
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

  const workspace = await getActiveWorkspace(client, user.id);
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
    redirect("/login");
  }
  return scope;
}
