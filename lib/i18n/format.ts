import { intlLocales, type Locale } from "@/lib/i18n/dictionaries";

/**
 * Date and time formatting for the shell.
 *
 * Everything goes through `Intl` so the two locales never need a translated
 * weekday or month table, and relative days ("today", "yesterday") come from
 * `Intl.RelativeTimeFormat` with `numeric: "auto"` for the same reason.
 */

const DAY_MS = 24 * 60 * 60_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Today", "Yesterday", a weekday for the last week, else "18 Sep". */
export function formatDayLabel(
  iso: string,
  locale: Locale,
  now: Date = new Date()
): string {
  const date = new Date(iso);
  const intl = intlLocales[locale];
  const diffDays = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);

  if (diffDays === 0 || diffDays === -1) {
    const relative = new Intl.RelativeTimeFormat(intl, { numeric: "auto" });
    return capitalize(relative.format(diffDays, "day"));
  }
  if (diffDays < 0 && diffDays > -7) {
    return capitalize(
      new Intl.DateTimeFormat(intl, { weekday: "long" }).format(date)
    );
  }
  return new Intl.DateTimeFormat(intl, { day: "numeric", month: "short" }).format(
    date
  );
}

/** "09:02" */
export function formatClock(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocales[locale], {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** The clock for today, the day label otherwise — a contact list's timestamp. */
export function formatWhen(
  iso: string,
  locale: Locale,
  now: Date = new Date()
): string {
  const date = new Date(iso);
  if (startOfDay(date) === startOfDay(now)) {
    return formatClock(iso, locale);
  }
  return formatDayLabel(iso, locale, now);
}

/** "Thu 18 Sep" */
export function formatDueDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocales[locale], {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}

/** "Friday", or "18 Sep" when it is further away than a week. */
export function formatDueWhen(
  iso: string,
  locale: Locale,
  now: Date = new Date()
): string {
  const date = new Date(iso);
  const intl = intlLocales[locale];
  const diffDays = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);

  if (diffDays >= 0 && diffDays <= 1) {
    const relative = new Intl.RelativeTimeFormat(intl, { numeric: "auto" });
    return relative.format(diffDays, "day");
  }
  if (diffDays > 1 && diffDays < 7) {
    return new Intl.DateTimeFormat(intl, { weekday: "long" }).format(date);
  }
  return new Intl.DateTimeFormat(intl, { day: "numeric", month: "short" }).format(
    date
  );
}

/** "14 September 2026" */
export function formatLongDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocales[locale], {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}

/** "04:12" from milliseconds. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
