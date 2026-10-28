import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { appOrigin } from "@/agent/lib/email-template";

/**
 * The photo-upload link a caller gets by SMS.
 *
 * The token is the only credential: 32 random bytes, sent once, stored only as
 * its sha-256. The page behind it can add files to one inquiry and nothing
 * else — it cannot read what is there, and it expires.
 */

export const UPLOAD_BUCKET = "inquiry-files";
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const LINK_TTL_DAYS = 14;

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isAcceptedUpload(type: string, size: number): boolean {
  return type in ALLOWED_TYPES && size > 0 && size <= MAX_UPLOAD_BYTES;
}

export async function createUploadLink(
  admin: SupabaseClient,
  input: { workspaceId: string; inquiryId: string }
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const { error } = await admin.from("inquiry_upload_links").insert({
    workspace_id: input.workspaceId,
    inquiry_id: input.inquiryId,
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + LINK_TTL_DAYS * 86_400_000).toISOString(),
  });
  if (error) throw new Error("Could not create the upload link");
  const origin = appOrigin() ?? "http://localhost:3000";
  return `${origin}/u/${token}`;
}

export type UploadLink = {
  id: string;
  workspaceId: string;
  inquiryId: string;
  maxFiles: number;
  expiresAt: string;
  filesSoFar: number;
  businessName: string;
};

export async function resolveUploadLink(
  admin: SupabaseClient,
  token: string
): Promise<UploadLink | null> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const { data } = await admin
    .from("inquiry_upload_links")
    .select("id, workspace_id, inquiry_id, max_files, expires_at")
    .eq("token_hash", hashToken(token))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle<{
      id: string;
      workspace_id: string;
      inquiry_id: string;
      max_files: number;
      expires_at: string;
    }>();
  if (!data) return null;

  const [{ count }, { data: profile }] = await Promise.all([
    admin
      .from("inquiry_files")
      .select("id", { count: "exact", head: true })
      .eq("link_id", data.id),
    admin
      .from("business_profiles")
      .select("name")
      .eq("workspace_id", data.workspace_id)
      .maybeSingle<{ name: string }>(),
  ]);

  return {
    id: data.id,
    workspaceId: data.workspace_id,
    inquiryId: data.inquiry_id,
    maxFiles: data.max_files,
    expiresAt: data.expires_at,
    filesSoFar: count ?? 0,
    businessName: profile?.name ?? "",
  };
}

export async function storeUpload(
  admin: SupabaseClient,
  link: UploadLink,
  file: { name: string; type: string; bytes: Buffer }
): Promise<{ ok: true } | { ok: false; reason: "type" | "full" | "storage" }> {
  if (!isAcceptedUpload(file.type, file.bytes.length)) return { ok: false, reason: "type" };
  if (link.filesSoFar >= link.maxFiles) return { ok: false, reason: "full" };

  const path = `${link.workspaceId}/${link.inquiryId}/${randomUUID()}.${ALLOWED_TYPES[file.type]}`;
  const upload = await admin.storage.from(UPLOAD_BUCKET).upload(path, file.bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (upload.error) return { ok: false, reason: "storage" };

  const { error } = await admin.from("inquiry_files").insert({
    workspace_id: link.workspaceId,
    inquiry_id: link.inquiryId,
    link_id: link.id,
    storage_path: path,
    file_name: file.name.slice(0, 200),
    mime_type: file.type,
    size_bytes: file.bytes.length,
  });
  if (error) {
    await admin.storage.from(UPLOAD_BUCKET).remove([path]);
    return { ok: false, reason: "storage" };
  }
  link.filesSoFar += 1;
  return { ok: true };
}
