import type { SupabaseClient } from "@supabase/supabase-js";

import { DEFAULT_PLAN, isPlanId, type PlanId } from "@/lib/subscription";

export type WorkspaceRole = "owner" | "admin" | "member";

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  plan: PlanId;
  stripeCustomerId: string | null;
};

type MembershipRow = {
  role: WorkspaceRole;
  workspaces: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    stripe_customer_id: string | null;
  } | null;
};

/**
 * The MVP has exactly one workspace per user, created by a signup trigger.
 * The membership lookup is already the multi-workspace shape so that adding a
 * switcher later does not touch callers.
 */
export async function getActiveWorkspace(
  client: SupabaseClient,
  userId: string
): Promise<Workspace | null> {
  const { data, error } = await client
    .from("workspace_members")
    .select("role, workspaces:workspace_id (id, name, slug, plan, stripe_customer_id)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<MembershipRow>();

  if (error || !data?.workspaces) {
    return null;
  }

  return {
    id: data.workspaces.id,
    name: data.workspaces.name,
    slug: data.workspaces.slug,
    role: data.role,
    plan: isPlanId(data.workspaces.plan) ? data.workspaces.plan : DEFAULT_PLAN,
    stripeCustomerId: data.workspaces.stripe_customer_id,
  };
}

export async function requireActiveWorkspace(
  client: SupabaseClient,
  userId: string
): Promise<Workspace> {
  const workspace = await getActiveWorkspace(client, userId);
  if (!workspace) {
    throw new Error(`User ${userId} has no workspace membership`);
  }
  return workspace;
}
