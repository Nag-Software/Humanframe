import { z } from "zod";

import { getServiceRoleClient } from "@/lib/supabase/server";
import { confirmUploads, prepareUploads, resolveUploadLink } from "@/server/receptionist/uploads";

/**
 * The photo-upload page's two calls: `prepare` hands out signed upload URLs,
 * `confirm` registers what arrived. The token in the path is the only
 * credential; it can add files to one inquiry until it expires.
 */

const schema = z.discriminatedUnion("step", [
  z.object({
    step: z.literal("prepare"),
    files: z
      .array(z.object({ name: z.string().max(300), type: z.string().max(100), size: z.number().int().positive() }))
      .min(1)
      .max(10),
  }),
  z.object({
    step: z.literal("confirm"),
    files: z.array(z.object({ path: z.string().max(300), name: z.string().max(300) })).min(1).max(10),
  }),
]);

export async function POST(request: Request, context: RouteContext<"/api/public/uploads/[token]">) {
  const { token } = await context.params;
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid" }, { status: 400 });

  const admin = getServiceRoleClient();
  const link = await resolveUploadLink(admin, token);
  if (!link) return Response.json({ error: "expired" }, { status: 404 });

  if (body.data.step === "prepare") {
    const uploads = await prepareUploads(admin, link, body.data.files);
    return Response.json({ uploads });
  }

  const stored = await confirmUploads(admin, link, body.data.files);
  if (stored > 0) {
    await admin.from("inquiries").update({ status: "open" }).eq("id", link.inquiryId);
  }
  return Response.json({ stored });
}
