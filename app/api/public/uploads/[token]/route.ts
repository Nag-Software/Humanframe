import { getServiceRoleClient } from "@/lib/supabase/server";
import { resolveUploadLink, storeUpload } from "@/server/receptionist/uploads";

/**
 * Files from the photo-upload page. The token in the path is the only
 * credential; it can add files to one inquiry until it expires.
 */

export const maxDuration = 60;

export async function POST(request: Request, context: RouteContext<"/api/public/uploads/[token]">) {
  const { token } = await context.params;
  const admin = getServiceRoleClient();
  const link = await resolveUploadLink(admin, token);
  if (!link) return Response.json({ error: "expired" }, { status: 404 });

  const form = await request.formData().catch(() => null);
  const files = (form?.getAll("files") ?? []).filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) return Response.json({ error: "no_files" }, { status: 400 });

  let stored = 0;
  const rejected: string[] = [];
  for (const file of files.slice(0, 10)) {
    const result = await storeUpload(admin, link, {
      name: file.name,
      type: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    if (result.ok) stored += 1;
    else rejected.push(`${file.name}: ${result.reason}`);
  }

  if (stored > 0) {
    await admin.from("inquiries").update({ status: "open" }).eq("id", link.inquiryId);
  }
  return Response.json({ stored, rejected }, { status: stored > 0 ? 200 : 400 });
}
