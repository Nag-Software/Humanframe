import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Service-role client for the eve runtime.
 *
 * Hooks run outside any request, so there is no user session to scope by.
 * Every write therefore resolves and passes the workspace explicitly, and the
 * caller is responsible for never crossing a workspace boundary.
 */
export function getRuntimeSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return null;
  }
  client ??= createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
