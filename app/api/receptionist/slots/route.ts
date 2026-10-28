import { getServiceRoleClient } from "@/lib/supabase/server";
import { loadAvailability } from "@/server/receptionist/availability";
import { requireApiScope } from "@/server/receptionist/scope";
import { loadProfile } from "@/server/receptionist/store";

/** What the receptionist would offer a caller right now. */
export async function GET() {
  const auth = await requireApiScope();
  if ("response" in auth) return auth.response;
  const profile = await loadProfile(auth.scope.client, auth.scope.workspaceId);
  const availability = await loadAvailability(getServiceRoleClient(), profile, { calendarTimeoutMs: 8000 });
  return Response.json({
    slots: availability.slots.map((slot) => ({ start: slot.start.toISOString(), end: slot.end.toISOString() })),
    known: availability.known,
    calendarConnected: availability.calendarConnected,
    timezone: profile.timezone,
  });
}
