import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { errorFields, logger } from "@/lib/logger";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const DEFAULT_REDIRECT = "/assistants/maya";

/** Completes the magic-link sign-in (PKCE `code` or `token_hash` flow). */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const rawNext = searchParams.get("next");
  const next = rawNext?.startsWith("/") ? rawNext : DEFAULT_REDIRECT;

  const supabase = await createSupabaseServerClient();
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
      : { error: new Error("Missing sign-in credentials") };

  if (result.error) {
    logger.warn("auth.callback_failed", errorFields(result.error));
    return NextResponse.redirect(new URL("/login?error=expired", origin));
  }

  // Idempotent: creates the personal workspace, the owner membership and Maya
  // if they are missing. The signup trigger normally did this already, but an
  // OAuth user who predates the trigger converges here.
  const { error: bootstrapError } = await supabase.rpc("ensure_user_bootstrap");
  if (bootstrapError) {
    logger.error("auth.bootstrap_failed", errorFields(bootstrapError));
    return NextResponse.redirect(new URL("/login?error=bootstrap", origin));
  }

  return NextResponse.redirect(new URL(next, origin));
}
