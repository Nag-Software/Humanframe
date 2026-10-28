import { cn } from "@/lib/utils";

/** The one card. Hairline edge, soft depth, generous padding. */
export function Surface({
  children,
  className,
  tone = "default",
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  tone?: "default" | "muted" | "fjord" | "ink";
  as?: "div" | "section" | "li" | "article";
}) {
  return (
    <Tag
      className={cn(
        "rounded-2xl",
        tone === "default" && "bg-card shadow-hairline",
        tone === "muted" && "bg-muted/60",
        tone === "fjord" && "bg-fjord text-fjord-foreground",
        tone === "ink" && "bg-primary text-primary-foreground",
        className
      )}
    >
      {children}
    </Tag>
  );
}

export type PillTone = "neutral" | "fjord" | "brass" | "ember" | "quiet";

export function Pill({
  children,
  tone = "neutral",
  className,
  dot = false,
}: {
  children: React.ReactNode;
  tone?: PillTone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap",
        tone === "neutral" && "bg-secondary text-secondary-foreground",
        tone === "fjord" && "bg-fjord-soft text-fjord",
        tone === "brass" && "bg-brass-soft text-[color:oklch(0.45_0.08_70)] dark:text-brass",
        tone === "ember" && "bg-ember-soft text-ember",
        tone === "quiet" && "text-muted-foreground border",
        className
      )}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "brass" | "fjord";
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-[12px] font-medium tracking-[0.06em] uppercase">{label}</span>
      <span
        className={cn(
          "font-serif tabular text-[2.25rem] leading-none tracking-[-0.02em]",
          tone === "brass" && "text-[color:oklch(0.5_0.09_72)] dark:text-brass",
          tone === "fjord" && "text-fjord"
        )}
      >
        {value}
      </span>
      {hint ? <span className="text-muted-foreground text-[13px]">{hint}</span> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="grain flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-14 text-center">
      {icon ? (
        <span className="bg-card text-fjord shadow-hairline mb-1 flex size-11 items-center justify-center rounded-xl">
          {icon}
        </span>
      ) : null}
      <p className="font-serif text-2xl leading-tight">{title}</p>
      {body ? <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Initials in a warm disc: the caller, the customer, the person. */
export function Initials({ name, className }: { name: string; className?: string }) {
  const letters =
    name
      .replace(/[^\p{L}\s]/gu, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "·";
  return (
    <span
      aria-hidden
      className={cn(
        "bg-secondary text-secondary-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
        className
      )}
    >
      {letters}
    </span>
  );
}
