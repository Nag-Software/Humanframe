"use client";

import { useState } from "react";

import { useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.82-.07-1.6-.21-2.36H12v4.47h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.73Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.28a12 12 0 0 0 0 10.76l4.01-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.18 15.24 0 12 0A12 12 0 0 0 1.28 6.62l4.01 3.09C6.23 6.87 8.88 4.75 12 4.75Z"
      />
    </svg>
  );
}

/**
 * Google OAuth runs in the browser: Supabase needs to redirect the window to
 * Google and back to /auth/callback, where the session cookie is written.
 */
export function GoogleSignInButton({ next }: { next?: string }) {
  const t = useTranslations();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);

    const callback = new URL("/auth/callback", window.location.origin);
    if (next) {
      callback.searchParams.set("next", next);
    }

    const supabase = createSupabaseBrowserClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callback.toString() },
    });

    if (oauthError) {
      setPending(false);
      setError(t.auth.googleError);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        className="h-10 w-full gap-2.5 font-normal"
        disabled={pending}
        onClick={signIn}
      >
        <GoogleMark />
        {t.auth.continueWithGoogle}
      </Button>
      {error ? (
        <p role="status" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
