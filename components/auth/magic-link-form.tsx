"use client";

import { useActionState } from "react";

import { useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  sendSignInLink,
  verifySignInCode,
  type SignInState,
} from "@/app/(auth)/login/actions";

const initialState: SignInState = { status: "idle" };

export function MagicLinkForm({ next }: { next?: string }) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState(
    sendSignInLink,
    initialState
  );

  if (state.status === "sent" && state.email) {
    return <CodeForm email={state.email} next={next} sentMessage={state.message} />;
  }

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

      <Button type="submit" className="h-10" disabled={pending}>
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

/** Step two: the link in the email, or the code in the same email. */
function CodeForm({
  email,
  next,
  sentMessage,
}: {
  email: string;
  next?: string;
  sentMessage?: string;
}) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState(verifySignInCode, {
    status: "sent",
    email,
  } satisfies SignInState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <input type="hidden" name="email" value={email} />

      <p className="text-muted-foreground text-sm">{sentMessage ?? t.auth.sent}</p>

      <div className="flex flex-col gap-2">
        <label htmlFor="code" className="text-sm font-medium">
          {t.auth.codeLabel}
        </label>
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,12}"
          required
          className="h-10 tracking-widest"
          placeholder="123456"
          aria-describedby={state.message ? "code-message" : undefined}
        />
      </div>

      <Button type="submit" className="h-10" disabled={pending}>
        {pending ? t.auth.verifying : t.auth.verifyCode}
      </Button>

      {state.message ? (
        <p id="code-message" role="status" className="text-destructive text-sm">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
