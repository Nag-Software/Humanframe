import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { errorFields, logger } from "@/lib/logger";
import { safeNextPath } from "@/lib/safe-next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureBootstrap } from "@/server/auth/bootstrap";

const DEFAULT_REDIRECT = "/";

/** Completes the magic-link or OAuth sign-in (PKCE `code` or `token_hash`). */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"), DEFAULT_REDIRECT);

  // Supabase sends the user back with `error`/`error_code` when the provider
  // or the link itself failed. Say which, instead of "expired" for everything.
  const providerError = searchParams.get("error_code") ?? searchParams.get("error");
  if (providerError) {
    logger.warn("auth.callback_provider_error", { code: providerError });
    return NextResponse.redirect(
      new URL(`/login?error=${loginErrorFor(providerError)}`, origin)
    );
  }

  const supabase = await createSupabaseServerClient();
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
      : { data: { user: null }, error: new Error("Missing sign-in credentials") };

  if (result.error || !result.data.user) {
    logger.warn("auth.callback_failed", errorFields(result.error));
    // A PKCE link opened in another browser than the one that asked for it
    // has no code verifier. That is not an expired link, and the code in the
    // same email still works there.
    const message = result.error?.message ?? "";
    const reason = /verifier/i.test(message) ? "other_browser" : "expired";
    return NextResponse.redirect(new URL(`/login?error=${reason}`, origin));
  }

  const bootstrap = await ensureBootstrap(supabase, result.data.user.id);
  if (!bootstrap.ok) {
    return NextResponse.redirect(new URL("/login?error=bootstrap", origin));
  }

  return NextResponse.redirect(new URL(next, origin));
}

function loginErrorFor(code: string): string {
  if (code === "otp_expired" || code === "flow_state_expired") {
    return "expired";
  }
  if (code === "access_denied") {
    return "denied";
  }
  return "provider";
}
