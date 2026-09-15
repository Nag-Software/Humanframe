/**
 * Quiet hours.
 *
 * A person's quiet hours are wall-clock times in their own zone, so the answer
 * changes twice a year even though the stored values do not. Every comparison
 * therefore happens in the target zone via Intl, never by adding a fixed offset
 * to UTC — an offset computed in January is wrong in July.
 *
 * Quiet hours delay a notification; they never drop one.
 */

export type QuietHours = {
  start: string | null;
  end: string | null;
  timeZone: string | null;
};

/** Minutes since local midnight, in the given zone. */
export function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return (hour % 24) * 60 + minute;
}

export function parseClock(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isQuiet(at: Date, quiet: QuietHours): boolean {
  const zone = quiet.timeZone ?? "UTC";
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === null || end === null || start === end) {
    return false;
  }

  const now = localMinutes(at, zone);
  // A window that wraps midnight (22:00–07:00) is the common case.
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * When a notification held by quiet hours may be sent.
 *
 * Walks forward in real time rather than arithmetic on local minutes: on the
 * night the clocks change, the gap between "now" and "07:00 local" is 23 or 25
 * hours, not 24, and only the zone knows which.
 */
export function nextSendableTime(at: Date, quiet: QuietHours): Date {
  if (!isQuiet(at, quiet)) {
    return at;
  }

  const zone = quiet.timeZone ?? "UTC";
  const end = parseClock(quiet.end);
  if (end === null) {
    return at;
  }

  // Minute-by-minute would be exact but slow; stepping five minutes and then
  // refining keeps it bounded and still lands on the first quiet-free minute.
  const step = 5 * 60_000;
  let cursor = at.getTime();
  const limit = cursor + 26 * 60 * 60_000;

  while (cursor < limit) {
    cursor += step;
    if (!isQuiet(new Date(cursor), { ...quiet, timeZone: zone })) {
      let back = cursor;
      while (back - 60_000 > at.getTime() && !isQuiet(new Date(back - 60_000), quiet)) {
        back -= 60_000;
      }
      return new Date(back);
    }
  }

  // Quiet hours that never end are a misconfiguration; do not hold forever.
  return new Date(at.getTime() + 60 * 60_000);
}
