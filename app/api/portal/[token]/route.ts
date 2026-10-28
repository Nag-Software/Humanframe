import { z } from "zod";

import { getServiceRoleClient } from "@/lib/supabase/server";
import { decideQuote, postCustomerMessage, requestTime } from "@/server/receptionist/portal-actions";
import { resolvePortal } from "@/server/receptionist/portal";
import { getInquiry, loadProfile } from "@/server/receptionist/store";

/** What the customer does on their page. The token is the whole credential. */

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), quoteId: z.uuid() }),
  z.object({ action: z.literal("decline"), quoteId: z.uuid(), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal("time"), start: z.iso.datetime({ offset: true }) }),
  z.object({ action: z.literal("message"), text: z.string().min(1).max(2000) }),
]);

export async function POST(request: Request, context: RouteContext<"/api/portal/[token]">) {
  const { token } = await context.params;
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid" }, { status: 400 });

  const admin = getServiceRoleClient();
  const portal = await resolvePortal(admin, token);
  if (!portal) return Response.json({ error: "not_found" }, { status: 404 });
  const [profile, inquiry] = await Promise.all([
    loadProfile(admin, portal.workspaceId),
    getInquiry(admin, portal.inquiryId, portal.workspaceId),
  ]);
  if (!inquiry) return Response.json({ error: "not_found" }, { status: 404 });

  const data = body.data;
  if (data.action === "accept" || data.action === "decline") {
    const result = await decideQuote(admin, {
      profile,
      inquiryId: inquiry.id,
      quoteId: data.quoteId,
      accept: data.action === "accept",
      reason: data.action === "decline" ? data.reason : undefined,
    });
    return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: 409 });
  }
  if (data.action === "time") {
    const result = await requestTime(admin, {
      profile,
      inquiryId: inquiry.id,
      start: new Date(data.start),
      customerName: inquiry.callerName ?? "",
      customerPhone: inquiry.callerPhone,
      address: typeof inquiry.intake.address === "string" ? inquiry.intake.address : "",
      title: inquiry.title,
    });
    return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: 409 });
  }
  await postCustomerMessage(admin, {
    profile,
    inquiryId: inquiry.id,
    text: data.text,
    customerName: inquiry.callerName ?? "",
  });
  return Response.json({ ok: true });
}
