import type { Metadata } from "next";

import { BrandPanel } from "@/components/auth/brand-panel";
import { Logo } from "@/components/hf/logo";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { LanguageSwitcher } from "@/components/language-switcher";
import { MagicLinkForm } from "@/components/auth/magic-link-form";
import { getTranslations } from "@/lib/i18n";
import { safeNextPath } from "@/lib/safe-next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.auth.metaTitle };
}

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const params = await searchParams;
  const rawNext = typeof params.next === "string" ? params.next : undefined;
  const next = safeNextPath(rawNext, "") || undefined;
  const t = await getTranslations();
  const error = typeof params.error === "string" ? params.error : null;
  const errorMessage =
    error === "expired"
      ? t.auth.expiredLink
      : error === "other_browser"
        ? t.auth.otherBrowser
        : error === "denied"
          ? t.auth.deniedLink
          : error === "provider"
            ? t.auth.providerError
            : error === "bootstrap"
              ? t.auth.bootstrapError
              : null;

  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex items-center justify-between gap-2">
          <Logo />
          <LanguageSwitcher variant="compact" />
        </div>

        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-[360px] space-y-9">
            <div className="space-y-3">
              <h1 className="font-serif text-[2.75rem] leading-[1.02] tracking-[-0.02em]">{t.auth.title}</h1>
              <p className="text-muted-foreground text-[15px] leading-relaxed text-balance">{t.auth.description}</p>
            </div>

            <div className="space-y-5">
              <GoogleSignInButton next={next} />

              <div className="flex items-center gap-3">
                <span className="bg-border h-px flex-1" />
                <span className="text-muted-foreground text-xs">{t.auth.dividerOr}</span>
                <span className="bg-border h-px flex-1" />
              </div>

              <MagicLinkForm next={next} />
            </div>

            {errorMessage ? (
              <div className="bg-ember-soft space-y-3 rounded-xl p-4">
                <p role="status" className="text-ember text-sm leading-relaxed">
                  {errorMessage}
                </p>
                {error === "bootstrap" ? (
                  <form action="/auth/sign-out" method="post">
                    <button type="submit" className="text-sm font-medium underline underline-offset-4">
                      {t.auth.signOut}
                    </button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <p className="text-muted-foreground text-center text-xs">© Humanframe · Nag Software</p>
      </div>

      <div className="hidden p-3 lg:block">
        <div className="h-full overflow-hidden rounded-[28px]">
          <BrandPanel tagline={t.auth.brandTagline} line={t.auth.brandLine} />
        </div>
      </div>
    </div>
  );
}
