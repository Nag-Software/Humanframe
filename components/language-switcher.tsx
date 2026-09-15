"use client";

import { useFormStatus } from "react-dom";

import { useLocale, useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { setLocaleFromForm } from "@/lib/i18n/actions";
import { locales } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/utils";

function LocaleButtons() {
  const t = useTranslations();
  const locale = useLocale();
  const { pending } = useFormStatus();

  return (
    <div
      role="group"
      aria-label={t.locale.label}
      className="flex items-center gap-1"
    >
      {locales.map((code) => {
        const selected = code === locale;
        return (
          <Button
            key={code}
            type="submit"
            name="locale"
            value={code}
            size="sm"
            variant={selected ? "secondary" : "ghost"}
            aria-pressed={selected}
            disabled={pending || selected}
          >
            {t.locale.names[code]}
          </Button>
        );
      })}
    </div>
  );
}

export function LanguageSwitcher({
  variant = "row",
}: {
  variant?: "row" | "compact";
}) {
  const t = useTranslations();
  const buttons = (
    <form action={setLocaleFromForm}>
      <LocaleButtons />
    </form>
  );

  if (variant === "compact") {
    return buttons;
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border/60 p-4"
      )}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{t.locale.label}</p>
        <p className="text-muted-foreground text-sm">{t.locale.description}</p>
      </div>
      {buttons}
    </div>
  );
}
