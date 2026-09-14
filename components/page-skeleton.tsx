import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const row = "border-border/60 rounded-xl border p-4";

/**
 * Plassholderinnhold for sider som ennå ikke har data. Formen antyder hva
 * siden skal bli, uten å late som noe finnes.
 */
export function PageSkeleton({
  variant = "list",
  rows = 5,
  className,
}: {
  variant?: "list" | "cards" | "calendar" | "form" | "stats";
  rows?: number;
  className?: string;
}) {
  if (variant === "stats") {
    return (
      <div
        aria-hidden
        className={cn("grid gap-4 sm:grid-cols-3", className)}
      >
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className={cn(row, "space-y-3")}>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>
    );
  }

  if (variant === "cards") {
    return (
      <div aria-hidden className={cn("grid gap-4 sm:grid-cols-2", className)}>
        {Array.from({ length: rows }).map((_, index) => (
          <div key={index} className={cn(row, "flex items-center gap-3")}>
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === "calendar") {
    return (
      <div aria-hidden className={cn(row, "space-y-3", className)}>
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: 7 }).map((_, index) => (
            <Skeleton key={index} className="h-3 w-8" />
          ))}
        </div>
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: 35 }).map((_, index) => (
            <Skeleton key={index} className="h-12 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (variant === "form") {
    return (
      <div aria-hidden className={cn("max-w-xl space-y-6", className)}>
        {Array.from({ length: rows }).map((_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div aria-hidden className={cn("space-y-3", className)}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className={cn(row, "flex items-center gap-4")}>
          <Skeleton className="size-4 shrink-0 rounded" />
          <Skeleton className="h-3.5 flex-1 max-w-[18rem]" />
          <Skeleton className="ms-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
