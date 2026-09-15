import Image from "next/image";
import type { Metadata } from "next";

import { AuthVisualPanel } from "@/components/auth/auth-visual-panel";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { LanguageSwitcher } from "@/components/language-switcher";
import { MagicLinkForm } from "@/components/auth/magic-link-form";
import { getTranslations } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.auth.metaTitle };
}

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const params = await searchParams;
  const rawNext = typeof params.next === "string" ? params.next : undefined;
  const next = rawNext?.startsWith("/") ? rawNext : undefined;
  const expired = params.error === "expired";
  const t = await getTranslations();

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2.5 font-medium">
            <Image
              src="/icon.png"
              alt=""
              width={64}
              height={64}
              className="size-7"
            />
            <span className="font-display tracking-[-0.04em]">Humanframe</span>
          </span>
          <LanguageSwitcher variant="compact" />
        </div>

        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs space-y-8">
            <div className="space-y-2">
              <h1 className="font-display text-2xl font-medium tracking-tight">
                {t.auth.title}
              </h1>
              <p className="text-muted-foreground text-sm text-balance">
                {t.auth.description}
              </p>
            </div>

            <div className="space-y-5">
              <GoogleSignInButton next={next} />

              <div className="flex items-center gap-3">
                <span className="bg-border h-px flex-1" />
                <span className="text-muted-foreground text-xs">
                  {t.auth.dividerOr}
                </span>
                <span className="bg-border h-px flex-1" />
              </div>

              <MagicLinkForm next={next} />
            </div>

            {expired ? (
              <p role="status" className="text-destructive text-sm">
                {t.auth.expiredLink}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="bg-muted relative hidden lg:block">
        <AuthVisualPanel />
      </div>
    </div>
  );
}
