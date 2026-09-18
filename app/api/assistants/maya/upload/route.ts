import { z } from "zod";

import { errorFields, logger } from "@/lib/logger";
import { MAYA_BUCKET } from "@/lib/supabase/server";
import { recordAttachment } from "@/server/db/repositories/attachments";
import { getRequestScope } from "@/server/db/request-scope";
import { LIMITS, rateLimitedResponse, takeRateLimit } from "@/server/rate-limit";

const MAX_SIZE = 20 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 30;

// Mirrors the accept list in the composer's attachment adapter.
const ALLOWED_MEDIA_TYPES = [
  /^image\/(png|jpeg|gif|webp|avif|heic)$/,
  /^application\/pdf$/,
  /^application\/json$/,
  /^text\/(plain|markdown|csv)$/,
];

const threadIdSchema = z.uuid();

export async function POST(req: Request) {
  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await takeRateLimit(scope.client, LIMITS.upload))) {
    return rateLimitedResponse(LIMITS.upload);
  }

  const form = await req.formData();
  const file = form.get("file");
  const rawThreadId = form.get("threadId");

  if (!(file instanceof File)) {
    return Response.json({ error: "Mangler fil" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return Response.json(
      { error: "Filen er for stor (maks 20 MB)" },
      { status: 413 }
    );
  }

  const mediaType = file.type || "application/octet-stream";
  if (!ALLOWED_MEDIA_TYPES.some((pattern) => pattern.test(mediaType))) {
    return Response.json({ error: "Filtypen støttes ikke" }, { status: 415 });
  }

  const parsedThread = threadIdSchema.safeParse(rawThreadId);
  const threadId = parsedThread.success ? parsedThread.data : null;

  // The path is built server-side and always starts with the workspace id —
  // the storage policy authorizes on that first segment.
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 100);
  const path = `${scope.workspaceId}/${threadId ?? "unassigned"}/${crypto.randomUUID()}-${safeName}`;

  const storage = scope.client.storage.from(MAYA_BUCKET);
  const { error: uploadError } = await storage.upload(
    path,
    await file.arrayBuffer(),
    { contentType: mediaType, upsert: false }
  );

  if (uploadError) {
    logger.error("maya.upload_failed", {
      workspaceId: scope.workspaceId,
      ...errorFields(uploadError),
    });
    return Response.json({ error: "Opplasting feilet" }, { status: 500 });
  }

  // The bucket is private. The model needs a fetchable URL, so we mint a
  // signed one for this turn. The URL is never stored: the attachment row
  // keeps the storage path, and later reads re-sign from that.
  const { data: signed, error: signError } = await storage.createSignedUrl(
    path,
    SIGNED_URL_TTL_SECONDS
  );

  if (signError || !signed) {
    logger.error("maya.sign_url_failed", {
      workspaceId: scope.workspaceId,
      ...errorFields(signError),
    });
    return Response.json({ error: "Opplasting feilet" }, { status: 500 });
  }

  const attachmentId = await recordAttachment(scope, {
    threadId,
    filename: file.name,
    mediaType,
    size: file.size,
    storagePath: path,
  });

  return Response.json({
    id: attachmentId,
    url: signed.signedUrl,
    path,
    filename: file.name,
    mediaType,
    size: file.size,
  });
}
