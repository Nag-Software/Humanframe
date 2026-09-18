import type { SupabaseClient } from "@supabase/supabase-js";

export type Assistant = {
  id: string;
  name: string;
  slug: string;
  role: string | null;
  status: string;
  /** When she joined the workspace — the one date her profile shows. */
  createdAt: string;
};

type Row = {
  id: string;
  name: string;
  slug: string;
  role: string | null;
  status: string;
  created_at: string;
};

/** Every workspace gets one Maya from the signup trigger. */
export async function getAssistantBySlug(
  client: SupabaseClient,
  workspaceId: string,
  slug: string
): Promise<Assistant | null> {
  const { data, error } = await client
    .from("assistants")
    .select("id, name, slug, role, status, created_at")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle<Row>();

  if (error || !data) {
    return null;
  }
  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    role: data.role,
    status: data.status,
    createdAt: data.created_at,
  };
}
