import { getServiceRoleClient } from "@/lib/supabase/server";
import { buildIcsFeed } from "@/server/calendar/ics";
import { listBookings } from "@/server/receptionist/store";

/**
 * The bookings as a calendar subscription. The token in the URL is the
 * credential; rotating it in Oppsett revokes every old subscription.
 */
export async function GET(_request: Request, context: RouteContext<"/api/calendar/feed/[token]">) {
  const { token } = await context.params;
  const clean = token.replace(/\.ics$/, "");
  if (!/^[0-9a-f]{48}$/.test(clean)) return new Response("Not found", { status: 404 });

  const admin = getServiceRoleClient();
  const { data: profile } = await admin
    .from("business_profiles")
    .select("workspace_id, name")
    .eq("calendar_feed_token", clean)
    .maybeSingle<{ workspace_id: string; name: string }>();
  if (!profile) return new Response("Not found", { status: 404 });

  const now = Date.now();
  const bookings = await listBookings(admin, profile.workspace_id, {
    from: new Date(now - 30 * 86_400_000),
    to: new Date(now + 180 * 86_400_000),
  });

  const ics = buildIcsFeed({
    name: profile.name ? `${profile.name} – bookinger` : "Bookinger",
    events: bookings.map((booking) => ({
      id: booking.id,
      start: new Date(booking.startsAt),
      end: new Date(booking.endsAt),
      title: booking.title,
      description: [booking.customerName, booking.customerPhone, booking.notes].filter(Boolean).join("\n"),
      location: booking.address,
    })),
  });

  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "private, max-age=300",
    },
  });
}
