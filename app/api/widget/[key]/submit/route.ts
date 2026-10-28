import { after } from "next/server";
import { z } from "zod";

import { getServiceRoleClient } from "@/lib/supabase/server";
import { processInquiry } from "@/server/receptionist/processing";
import { profileForWidget, submitSession } from "@/server/widget/sessions";

export const maxDuration = 120;

const schema = z.object({
  sessionId: z.string(),
  name: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().max(200).optional(),
});

/**
 * The customer pressed "Send". The draft becomes an inquiry, and the same
 * pipeline as a call runs after the response: intake, quote and booking
 * proposals, the owner told.
 */
export async function POST(request: Request, context: RouteContext<"/api/widget/[key]/submit">) {
  const { key } = await context.params;
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid" }, { status: 400 });

  const admin = getServiceRoleClient();
  const profile = await profileForWidget(admin, key);
  if (!profile) return Response.json({ error: "not_found" }, { status: 404 });

  const result = await submitSession(admin, profile, body.data.sessionId, {
    name: body.data.name || undefined,
    phone: body.data.phone || undefined,
    email: body.data.email || undefined,
  });
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  }

  after(async () => {
    await processInquiry(admin, result.inquiryId);
  });
  return Response.json({ portalUrl: result.portalUrl });
}
