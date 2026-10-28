/**
 * Wall-clock time in a named timezone, without a date library.
 *
 * Everything the receptionist says about time is local to the business —
 * "tomorrow at nine" in Bergen — while everything stored is UTC. Intl knows
 * every zone's offset history; these helpers are the two conversions built on
 * it, and they are pure so they can be tested against DST boundaries.
 */

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: Weekday;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** What a clock on the wall in `timeZone` shows at `date`. */
export function localParts(date: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday.toLowerCase().slice(0, 3) as Weekday,
  };
}

/** Offset of `timeZone` from UTC at `date`, in minutes (Oslo summer: +120). */
export function offsetMinutes(date: Date, timeZone: string): number {
  const local = localParts(date, timeZone);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute
  );
  const truncated = Math.floor(date.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - truncated) / 60_000);
}

/**
 * The instant a wall clock in `timeZone` shows this date and time.
 *
 * Two passes, because the offset to subtract depends on the instant being
 * computed. In the spring-forward gap (02:30 on the last Sunday of March in
 * Oslo) there is no such instant; this returns the one an hour later, which
 * is what a person means.
 */
export function zonedTime(
  date: { year: number; month: number; day: number },
  time: { hour: number; minute: number },
  timeZone: string
): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const first = naive - offsetMinutes(new Date(naive), timeZone) * 60_000;
  const second = naive - offsetMinutes(new Date(first), timeZone) * 60_000;
  return new Date(second);
}

/** Adds whole calendar days to a local date. */
export function addDays(
  date: { year: number; month: number; day: number },
  days: number
): { year: number; month: number; day: number } {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

export function weekdayOf(date: { year: number; month: number; day: number }): Weekday {
  return WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
}

/** "HH:MM" → minutes after midnight, or null. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute > 0)) return null;
  return hour * 60 + minute;
}

/** A human, Norwegian description of an instant: "torsdag 30. oktober kl. 10:00". */
export function describeLocal(date: Date, timeZone: string, locale = "nb-NO"): string {
  const day = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return locale.startsWith("nb") || locale.startsWith("no")
    ? `${day} kl. ${time}`
    : `${day} at ${time}`;
}
