import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * Every signed-in page has the same frame: a quiet top bar, an editorial
 * title, then content in a readable column. Pages differ in what they say,
 * not in how they hold it.
 */
export function Page({
  children,
  width = "default",
}: {
  children: React.ReactNode;
  width?: "default" | "wide" | "narrow";
}) {
  return (
    <div className="flex h-svh flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex w-full flex-col gap-10 px-5 pt-3 pb-24 sm:px-8",
            width === "wide" ? "max-w-[1080px]" : width === "narrow" ? "max-w-[620px]" : "max-w-[840px]"
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  back,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="flex flex-col gap-6">
      <div className="-ml-2 flex h-12 items-center gap-1">
        <SidebarTrigger className="text-muted-foreground" />
        {back ? (
          <Link
            href={back.href}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] transition-colors"
          >
            <ArrowLeftIcon className="size-3.5" />
            {back.label}
          </Link>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="flex max-w-[620px] flex-col gap-2">
          {eyebrow ? (
            <div className="text-muted-foreground flex items-center gap-2 text-[12px] font-medium tracking-[0.08em] uppercase">
              {eyebrow}
            </div>
          ) : null}
          <h1 className="font-serif text-[2.5rem] leading-[1.05] tracking-[-0.02em] text-balance sm:text-[3rem]">
            {title}
          </h1>
          {description ? (
            <p className="text-muted-foreground text-[15px] leading-relaxed text-pretty">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Section({
  title,
  description,
  aside,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-4", className)}>
      {title ? (
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
            {description ? <p className="text-muted-foreground text-sm leading-relaxed">{description}</p> : null}
          </div>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}
