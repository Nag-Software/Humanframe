import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { publicEnv, serverEnv } from "@/lib/env";

export const MAYA_BUCKET = "maya-attachments";

/**
 * Request-scoped client that acts as the signed-in user. This is the default:
 * every query it runs is subject to row level security.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component. The proxy refreshes the session,
            // so dropping the write here is safe.
          }
        },
      },
    }
  );
}

let serviceRoleClient: SupabaseClient | null = null;

/**
 * Bypasses row level security. Only for work that has no user session —
 * webhooks, agent hooks and background workflows — and only after the caller
 * has established which workspace the work belongs to.
 */
export function getServiceRoleClient(): SupabaseClient {
  const env = serverEnv();
  serviceRoleClient ??= createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  return serviceRoleClient;
}
