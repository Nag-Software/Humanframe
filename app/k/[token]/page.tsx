import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PortalView } from "@/components/portal/portal-view";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { loadAvailability } from "@/server/receptionist/availability";
import { resolvePortal } from "@/server/receptionist/portal";
import { listQuotes } from "@/server/receptionist/quotes";
import { getInquiry, listActions, loadProfile } from "@/server/receptionist/store";

export const metadata: Metadata = {
  title: "Saken din",
  robots: { index: false, follow: false },
};

/**
 * The customer's page for one request: where it stands, the quote, a time,
 * photos, a message. No account; the token in the link is the credential.
 */
export default async function PortalPage({ params }: PageProps<"/k/[token]">) {
  const { token } = await params;
  const admin = getServiceRoleClient();
  const portal = await resolvePortal(admin, token);
  if (!portal) notFound();

  const [profile, inquiry, quotes, actions, bookings, files] = await Promise.all([
    loadProfile(admin, portal.workspaceId),
    getInquiry(admin, portal.inquiryId, portal.workspaceId),
    listQuotes(admin, portal.workspaceId, { inquiryId: portal.inquiryId }),
    listActions(admin, portal.workspaceId, [portal.inquiryId]),
    admin
      .from("bookings")
      .select("starts_at, ends_at")
      .eq("inquiry_id", portal.inquiryId)
      .eq("status", "confirmed")
      .order("starts_at", { ascending: true })
      .returns<{ starts_at: string; ends_at: string }[]>(),
    admin.from("inquiry_files").select("id", { count: "exact", head: true }).eq("inquiry_id", portal.inquiryId),
  ]);
  if (!inquiry || inquiry.status === "draft") notFound();

  // The customer has seen the quote: the owner can tell "not opened" from "thinking".
  const unseen = quotes.filter((quote) => !quote.viewedAt).map((quote) => quote.id);
  if (unseen.length) {
    await admin.from("quotes").update({ viewed_at: new Date().toISOString() }).in("id", unseen);
  }

  const booked = bookings.data?.[0] ?? null;
  const requested = actions.find((action) => action.kind === "booking" && action.status === "proposed");
  const slots =
    profile.bookingEnabled && !booked
      ? (await loadAvailability(admin, profile, { calendarTimeoutMs: 4000, limit: 8 })).slots
      : [];

  return (
    <PortalView
      token={token}
      business={{
        name: profile.name || "Bedriften",
        phone: profile.contactPhone,
        email: profile.contactEmail,
        color: profile.widgetColor,
        timeZone: profile.timezone,
      }}
      inquiry={{
        title: inquiry.title,
        summary: inquiry.summary,
        customerName: inquiry.callerName,
        startedAt: inquiry.startedAt,
        status: inquiry.status,
        photos: files.count ?? 0,
      }}
      quotes={quotes.map((quote) => ({
        id: quote.id,
        number: quote.number,
        status: quote.status,
        title: quote.title,
        lines: quote.lines,
        notes: quote.notes,
        terms: quote.terms,
        pricesIncludeVat: quote.pricesIncludeVat,
        subtotal: quote.subtotal,
        vat: quote.vat,
        total: quote.total,
        validUntil: quote.validUntil,
      }))}
      booked={booked ? { start: booked.starts_at, end: booked.ends_at } : null}
      requested={typeof requested?.payload.startsAt === "string" ? requested.payload.startsAt : null}
      slots={slots.map((slot) => slot.start.toISOString())}
    />
  );
}
