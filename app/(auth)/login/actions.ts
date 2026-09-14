"use server";

import { z } from "zod";

import { serverEnv } from "@/lib/env";
import { getDictionary, getLocale } from "@/lib/i18n";
import { errorFields, logger } from "@/lib/logger";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type SignInState = {
  status: "idle" | "sent" | "error";
  message?: string;
};

const schema = z.object({
  email: z.email(),
  next: z.string().startsWith("/").optional(),
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

  const callback = new URL("/auth/callback", serverEnv().APP_URL);
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
    return { status: "error", message: t.auth.genericError };
  }

  logger.info("auth.signin_link_sent");
  return { status: "sent", message: t.auth.sent };
}
