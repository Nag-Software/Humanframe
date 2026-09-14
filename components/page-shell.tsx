import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Felles ramme for sidene: rolig, sentrert kolonne med tittel og innhold.
 */
export function PageShell({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-5xl px-6 pb-16", className)}>
      <div className="flex items-start gap-4 pb-8">
        <div className="min-w-0 space-y-1">
          <h1 className="font-display text-2xl tracking-tight">{title}</h1>
          {description ? (
            <p className="text-muted-foreground text-sm">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="ms-auto shrink-0">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
