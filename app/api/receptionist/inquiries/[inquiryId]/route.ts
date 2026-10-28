import { z } from "zod";

import { getServiceRoleClient } from "@/lib/supabase/server";
import { requireApiScope } from "@/server/receptionist/scope";
import { getInquiry } from "@/server/receptionist/store";

const schema = z.object({ status: z.enum(["open", "handled", "dismissed"]) });

export async function PATCH(request: Request, context: RouteContext<"/api/receptionist/inquiries/[inquiryId]">) {
  const auth = await requireApiScope();
  if ("response" in auth) return auth.response;
  const { scope } = auth;

  const { inquiryId } = await context.params;
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(inquiryId).success || !body.success) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  const inquiry = await getInquiry(scope.client, inquiryId, scope.workspaceId);
  if (!inquiry) return Response.json({ error: "not_found" }, { status: 404 });

  await getServiceRoleClient()
    .from("inquiries")
    .update({ status: body.data.status })
    .eq("id", inquiry.id)
    .eq("workspace_id", scope.workspaceId);
  return Response.json({ ok: true });
}
