"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { useTranslations } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations();
  const tabs = [
    { href: "/settings/general", label: t.settings.pages.general.title },
    {
      href: "/settings/notifications",
      label: t.settings.pages.notifications.title,
    },
    { href: "/settings/team", label: t.settings.pages.team.title },
    { href: "/settings/billing", label: t.settings.pages.billing.title },
    { href: "/settings/limits", label: t.settings.pages.limits.title },
  ];

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 pb-16">
      <h1 className="font-display pb-6 text-2xl tracking-tight">
        {t.settings.title}
      </h1>
      <nav className="border-border/60 mb-8 flex gap-1 border-b">
        {tabs.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                active
                  ? "border-foreground text-foreground"
                  : "text-muted-foreground hover:text-foreground border-transparent"
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
