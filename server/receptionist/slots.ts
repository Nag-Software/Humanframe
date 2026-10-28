import type { OpeningHours } from "./profile";
import { addDays, localParts, parseClock, weekdayOf, zonedTime } from "./time";

/**
 * Free appointment slots: opening hours, minus what is already booked, minus
 * what the owner's calendar says is busy, minus the notice the business needs.
 *
 * Pure, so the arithmetic that decides what the AI offers a caller is tested
 * rather than trusted.
 */

export type Interval = { start: Date; end: Date };

export type SlotInput = {
  now: Date;
  timeZone: string;
  hours: OpeningHours;
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  busy: Interval[];
  /** How far ahead to look. */
  days?: number;
  /** Granularity of start times. */
  stepMinutes?: number;
  /** How many to return in total. */
  limit?: number;
  /** How many per day, so the offer spans more than one morning. */
  perDay?: number;
};

export function freeSlots(input: SlotInput): Interval[] {
  const days = input.days ?? 14;
  const step = input.stepMinutes ?? 30;
  const limit = input.limit ?? 6;
  const perDay = input.perDay ?? 2;
  const duration = input.durationMinutes * 60_000;
  const buffer = input.bufferMinutes * 60_000;
  const earliest = input.now.getTime() + input.minNoticeHours * 3_600_000;

  // A booking blocks its buffer on both sides.
  const blocked = input.busy
    .map((interval) => ({
      start: interval.start.getTime() - buffer,
      end: interval.end.getTime() + buffer,
    }))
    .sort((a, b) => a.start - b.start);

  const today = localParts(input.now, input.timeZone);
  const slots: Interval[] = [];

  for (let offset = 0; offset < days && slots.length < limit; offset += 1) {
    const date = addDays(today, offset);
    const ranges = input.hours[weekdayOf(date)] ?? [];
    let takenToday = 0;

    for (const [open, close] of ranges) {
      const openMinutes = parseClock(open);
      const closeMinutes = parseClock(close);
      if (openMinutes === null || closeMinutes === null) continue;

      for (
        let minute = openMinutes;
        minute + input.durationMinutes <= closeMinutes;
        minute += step
      ) {
        if (takenToday >= perDay || slots.length >= limit) break;

        const start = zonedTime(
          date,
          { hour: Math.floor(minute / 60), minute: minute % 60 },
          input.timeZone
        ).getTime();
        const end = start + duration;
        if (start < earliest) continue;

        const clash = blocked.some((busy) => busy.start < end && busy.end > start);
        if (clash) continue;

        slots.push({ start: new Date(start), end: new Date(end) });
        takenToday += 1;
        // Two offers on one day should not be back to back.
        minute += Math.max(0, input.durationMinutes - step) + 60;
      }
    }
  }

  return slots;
}

/**
 * Whether an interval is in the future and clashes with nothing. Opening hours
 * are not checked: the owner may book outside them on purpose.
 */
export function isBookable(
  candidate: Interval,
  input: { now: Date; bufferMinutes: number; busy: Interval[] }
): boolean {
  if (candidate.start.getTime() < input.now.getTime()) return false;
  const buffer = input.bufferMinutes * 60_000;
  return !input.busy.some(
    (busy) =>
      busy.start.getTime() - buffer < candidate.end.getTime() &&
      busy.end.getTime() + buffer > candidate.start.getTime()
  );
}
