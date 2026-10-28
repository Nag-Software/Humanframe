"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { appOrigin } from "@/agent/lib/email-template";
import { getDictionary, getLocale } from "@/lib/i18n";
import { errorFields, logger } from "@/lib/logger";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureBootstrap } from "@/server/auth/bootstrap";

export type SignInState = {
  status: "idle" | "sent" | "error";
  message?: string;
  /** The address the link and code went to, so the code form can use it. */
  email?: string;
};

const nextSchema = z
  .string()
  .startsWith("/")
  .refine((value) => !value.startsWith("//"))
  .optional();

const schema = z.object({
  email: z.email(),
  next: nextSchema,
});

const codeSchema = z.object({
  email: z.email(),
  // Supabase sends 6 digits by default; projects can raise it to 10.
  code: z.string().regex(/^\d{6,10}$/),
  next: nextSchema,
});

export async function sendSignInLink(
  _previous: SignInState,
  formData: FormData
): Promise<SignInState> {
  const t = getDictionary(await getLocale());

  const parsed = schema.safeParse({
    email: String(formData.get("email") ?? "").trim(),
    next: formData.get("next") ? String(formData.get("next")) : undefined,
  });

  if (!parsed.success) {
    return { status: "error", message: t.auth.invalidEmail };
  }

  // The same guard email notifications use: a deployment that inherited a
  // development APP_URL must not mail out a link to localhost.
  const origin = appOrigin() ?? "http://localhost:3000";
  const callback = new URL("/auth/callback", origin);
  if (parsed.data.next) {
    callback.searchParams.set("next", parsed.data.next);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: callback.toString() },
  });

  if (error) {
    logger.error("auth.signin_link_failed", errorFields(error));
    const rateLimited = error.status === 429 || /rate/i.test(error.message);
    return {
      status: "error",
      message: rateLimited ? t.auth.rateLimited : t.auth.genericError,
    };
  }

  logger.info("auth.signin_link_sent");
  return { status: "sent", message: t.auth.sent, email: parsed.data.email };
}

/**
 * The code in the sign-in email, typed in by hand.
 *
 * A magic link only works in the browser that asked for it: the PKCE
 * verifier is a cookie there. Phones open mail links in an in-app browser,
 * so "the link does not work" was the most common way to fail to sign in.
 * The code has no such tie, and it is the same email.
 */
export async function verifySignInCode(
  _previous: SignInState,
  formData: FormData
): Promise<SignInState> {
  const t = getDictionary(await getLocale());

  const parsed = codeSchema.safeParse({
    email: String(formData.get("email") ?? "").trim(),
    code: String(formData.get("code") ?? "").replace(/\s+/g, ""),
    next: formData.get("next") ? String(formData.get("next")) : undefined,
  });

  if (!parsed.success) {
    return {
      status: "sent",
      email: String(formData.get("email") ?? ""),
      message: t.auth.invalidCode,
    };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: parsed.data.email,
    token: parsed.data.code,
    type: "email",
  });

  if (error || !data.user) {
    logger.warn("auth.code_failed", errorFields(error));
    return { status: "sent", email: parsed.data.email, message: t.auth.invalidCode };
  }

  const bootstrap = await ensureBootstrap(supabase, data.user.id);
  if (!bootstrap.ok) {
    redirect("/login?error=bootstrap");
  }

  redirect(parsed.data.next ?? "/");
}
