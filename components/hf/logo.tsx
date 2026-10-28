import { cn } from "@/lib/utils";

/**
 * The mark: a frame with an opening, and a point inside it — a person,
 * held by the work around them. Drawn on a 32-unit grid so it stays crisp
 * from a 16 px favicon to a hero.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden fill="none">
      <rect width="32" height="32" rx="9" className="fill-fjord" />
      <path
        d="M11 9.5H9.5A1.5 1.5 0 0 0 8 11v10a1.5 1.5 0 0 0 1.5 1.5H11M21 9.5h1.5A1.5 1.5 0 0 1 24 11v10a1.5 1.5 0 0 1-1.5 1.5H21"
        className="stroke-fjord-foreground"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2.75" className="fill-brass" />
    </svg>
  );
}

export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      {compact ? null : (
        <span className="font-serif text-[1.375rem] leading-none tracking-[-0.02em]">Humanframe</span>
      )}
    </span>
  );
}
