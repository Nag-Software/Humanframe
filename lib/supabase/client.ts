import { createBrowserClient } from "@supabase/ssr";

import { publicEnv } from "@/lib/env";

/** Browser client. Carries the user's session cookie; RLS applies. */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  );
}
