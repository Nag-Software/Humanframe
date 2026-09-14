import { getSupabaseAdmin, MAYA_BUCKET } from "@/lib/supabase/server";
import { recordAttachment } from "@/lib/maya/store";

const MAX_SIZE = 20 * 1024 * 1024;

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  const conversationId = form.get("conversationId");

  if (!(file instanceof File)) {
    return Response.json({ error: "Mangler fil" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return Response.json({ error: "Filen er for stor (maks 20 MB)" }, {
      status: 413,
    });
  }

  const db = getSupabaseAdmin();

  // Uten Supabase faller vi tilbake til data-URL, slik at vedlegg fungerer
  // lokalt uten lagring.
  if (!db) {
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return Response.json({
      url: `data:${file.type || "application/octet-stream"};base64,${base64}`,
      filename: file.name,
      mediaType: file.type,
      size: file.size,
      persisted: false,
    });
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `${conversationId ?? "uten-samtale"}/${crypto.randomUUID()}-${safeName}`;

  const { error } = await db.storage
    .from(MAYA_BUCKET)
    .upload(path, await file.arrayBuffer(), {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });

  if (error) {
    console.error("[maya] upload failed", error);
    return Response.json({ error: "Opplasting feilet" }, { status: 500 });
  }

  const {
    data: { publicUrl },
  } = db.storage.from(MAYA_BUCKET).getPublicUrl(path);

  await recordAttachment({
    conversationId: typeof conversationId === "string" ? conversationId : null,
    filename: file.name,
    mediaType: file.type || "application/octet-stream",
    size: file.size,
    storagePath: path,
    url: publicUrl,
  });

  return Response.json({
    url: publicUrl,
    filename: file.name,
    mediaType: file.type,
    size: file.size,
    persisted: true,
  });
}
