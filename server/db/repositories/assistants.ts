import type { SupabaseClient } from "@supabase/supabase-js";

export type Assistant = {
  id: string;
  name: string;
  slug: string;
  role: string | null;
  status: string;
};

/** Every workspace gets one Maya from the signup trigger. */
export async function getAssistantBySlug(
  client: SupabaseClient,
  workspaceId: string,
  slug: string
): Promise<Assistant | null> {
  const { data, error } = await client
    .from("assistants")
    .select("id, name, slug, role, status")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle<Assistant>();

  if (error) {
    return null;
  }
  return data;
}
