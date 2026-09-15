import type { MemoryScope } from "./memory-store";
import { getRuntimeSupabase } from "./supabase";

/**
 * Resolves the workspace and assistant a session belongs to.
 *
 * Every memory read and write is scoped by what this returns, so a session
 * that cannot be tied to a Supabase principal simply gets no memory rather
 * than a guess. The result is cached per session id because it cannot change
 * within one session.
 */
const cache = new Map<string, MemoryScope>();

type SessionLike = {
  id: string;
  auth: {
    initiator?: { principalId?: string; authenticator?: string } | null;
    current?: { principalId?: string; authenticator?: string } | null;
  };
};

export async function resolveMemoryScope(
  session: SessionLike
): Promise<MemoryScope | null> {
  const cached = cache.get(session.id);
  if (cached) {
    return cached;
  }

  const principal = session.auth.initiator ?? session.auth.current;
  if (principal?.authenticator !== "supabase" || !principal.principalId) {
    return null;
  }

  const client = getRuntimeSupabase();
  if (!client) {
    return null;
  }

  const { data: membership } = await client
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", principal.principalId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ workspace_id: string }>();

  if (!membership) {
    return null;
  }

  const { data: assistant } = await client
    .from("assistants")
    .select("id")
    .eq("workspace_id", membership.workspace_id)
    .eq("slug", "maya")
    .maybeSingle<{ id: string }>();

  if (!assistant) {
    return null;
  }

  const scope: MemoryScope = {
    client,
    workspaceId: membership.workspace_id,
    assistantId: assistant.id,
    userId: principal.principalId,
  };
  cache.set(session.id, scope);
  return scope;
}
