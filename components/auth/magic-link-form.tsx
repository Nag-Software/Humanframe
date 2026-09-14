"use client";

import { useActionState } from "react";

import { useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  sendSignInLink,
  type SignInState,
} from "@/app/(auth)/login/actions";

const initialState: SignInState = { status: "idle" };

export function MagicLinkForm({ next }: { next?: string }) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState(
    sendSignInLink,
    initialState
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <div className="flex flex-col gap-2">
        <label htmlFor="email" className="text-sm font-medium">
          {t.auth.emailLabel}
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="h-10"
          placeholder={t.auth.emailPlaceholder}
          aria-describedby={state.message ? "signin-message" : undefined}
        />
      </div>

      <Button
        type="submit"
        className="h-10"
        disabled={pending || state.status === "sent"}
      >
        {pending ? t.auth.submitting : t.auth.submit}
      </Button>

      {state.message ? (
        <p
          id="signin-message"
          role="status"
          className={
            state.status === "error"
              ? "text-destructive text-sm"
              : "text-muted-foreground text-sm"
          }
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
