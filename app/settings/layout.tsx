"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/settings/general", label: "Generelt" },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/billing", label: "Fakturering" },
  { href: "/settings/limits", label: "Grenser" },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pb-16">
      <h1 className="font-display pb-6 text-2xl tracking-tight">Innstillinger</h1>
      <nav className="border-border/60 mb-8 flex gap-1 border-b">
        {TABS.map((tab) => {
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
