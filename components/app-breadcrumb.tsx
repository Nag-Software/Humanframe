"use client";

import { usePathname } from "next/navigation";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

const LABELS: Record<string, string> = {
  assistants: "Assistants",
  maya: "Maya",
  "routine-tasks": "Routine tasks",
  calendar: "Calendar",
  settings: "Settings",
  general: "General",
  team: "Team",
  billing: "Billing",
  limits: "Limits",
};

const labelFor = (segment: string) =>
  LABELS[segment] ??
  segment.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Brødsmuler som følger ruten, i stedet for en fast tekst. */
export function AppBreadcrumb() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem className="hidden md:block">
          {segments.length === 0 ? (
            <BreadcrumbPage>Overview</BreadcrumbPage>
          ) : (
            <BreadcrumbLink href="/">Overview</BreadcrumbLink>
          )}
        </BreadcrumbItem>

        {segments.map((segment, index) => {
          const href = `/${segments.slice(0, index + 1).join("/")}`;
          const isLast = index === segments.length - 1;

          return (
            <span key={href} className="contents">
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{labelFor(segment)}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={href}>
                    {labelFor(segment)}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </span>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
