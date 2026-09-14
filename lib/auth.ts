import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function getCurrentUser(): Promise<User | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** For pages and route handlers that must not run without a session. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

export function displayName(user: User): string {
  const metadata = user.user_metadata as { full_name?: string; name?: string };
  return (
    metadata.full_name ??
    metadata.name ??
    user.email?.split("@")[0] ??
    "Bruker"
  );
}
