import type { SupabaseClient } from "@supabase/supabase-js";

import { errorFields, logger } from "@/lib/logger";
import { findCalendarAccount, readBusy } from "@/server/calendar/google";

import type { BusinessProfile } from "./profile";
import { freeSlots, type Interval } from "./slots";
import { listBookings } from "./store";

const LOOKAHEAD_DAYS = 14;

export type Availability = {
  slots: Interval[];
  busy: Interval[];
  /** False when the connected calendar could not be read in time. */
  known: boolean;
  calendarConnected: boolean;
};

/**
 * Free slots for the next two weeks: opening hours, minus our own bookings,
 * minus the connected calendar's busy time.
 *
 * Called while a phone is ringing, so the calendar read has a deadline. If it
 * misses it the receptionist is told it cannot see the calendar — offering a
 * time that turns out to be taken is worse than offering none.
 */
export async function loadAvailability(
  admin: SupabaseClient,
  profile: BusinessProfile,
  options: { now?: Date; calendarTimeoutMs?: number; limit?: number } = {}
): Promise<Availability> {
  const now = options.now ?? new Date();
  const to = new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000);

  const [bookings, account] = await Promise.all([
    listBookings(admin, profile.workspaceId, { from: now, to }),
    findCalendarAccount(admin, profile.workspaceId),
  ]);

  const busy: Interval[] = bookings.map((booking) => ({
    start: new Date(booking.startsAt),
    end: new Date(booking.endsAt),
  }));

  let known = true;
  if (account) {
    try {
      const calendarBusy = await withTimeout(
        readBusy(admin, account, { from: now, to, timeZone: profile.timezone }),
        options.calendarTimeoutMs ?? 2500
      );
      busy.push(...calendarBusy);
    } catch (error) {
      known = false;
      logger.warn("receptionist.calendar_unavailable", errorFields(error));
    }
  }

  const slots = known
    ? freeSlots({
        now,
        timeZone: profile.timezone,
        hours: profile.openingHours,
        durationMinutes: profile.appointmentMinutes,
        bufferMinutes: profile.bufferMinutes,
        minNoticeHours: profile.minNoticeHours,
        busy,
        days: LOOKAHEAD_DAYS,
        limit: options.limit ?? 6,
      })
    : [];

  return { slots, busy, known, calendarConnected: account !== null };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
