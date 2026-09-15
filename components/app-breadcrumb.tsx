"use client";

import { usePathname } from "next/navigation";

import { useTranslations } from "@/components/i18n-provider";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import type { Dictionary } from "@/lib/i18n/dictionaries";

const SEGMENT_KEYS = {
  assistants: "assistants",
  maya: "maya",
  "routine-tasks": "routineTasks",
  calendar: "calendar",
} as const satisfies Record<string, keyof Dictionary["nav"]>;

function labelFor(segment: string, nav: Dictionary["nav"]) {
  if (segment in SEGMENT_KEYS) {
    return nav[SEGMENT_KEYS[segment as keyof typeof SEGMENT_KEYS]];
  }

  return segment.replace(/-/g, " ").replace(/^\w/, (char) => char.toUpperCase());
}

/** Brødsmuler som følger ruten, i stedet for en fast tekst. */
export function AppBreadcrumb() {
  const pathname = usePathname();
  const t = useTranslations();
  const segments = pathname.split("/").filter(Boolean);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem className="hidden md:block">
          {segments.length === 0 ? (
            <BreadcrumbPage>{t.nav.overview}</BreadcrumbPage>
          ) : (
            <BreadcrumbLink href="/">{t.nav.overview}</BreadcrumbLink>
          )}
        </BreadcrumbItem>

        {segments.map((segment, index) => {
          const href = `/${segments.slice(0, index + 1).join("/")}`;
          const isLast = index === segments.length - 1;
          const label = labelFor(segment, t.nav);

          return (
            <span key={href} className="contents">
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={href}>{label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </span>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
