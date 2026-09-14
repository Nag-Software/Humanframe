import type { SupabaseClient } from "@supabase/supabase-js";

import { errorFields, logger } from "@/lib/logger";
import { MAYA_BUCKET } from "@/lib/supabase/server";

const ATTACHMENTS = "attachments";

export type AttachmentScope = {
  client: SupabaseClient;
  workspaceId: string;
};

export type AttachmentRecord = {
  threadId?: string | null;
  filename: string;
  mediaType: string;
  size?: number;
  storagePath: string;
  checksum?: string;
};

/**
 * Storage holds the bytes; this row holds the path. Signed URLs are minted on
 * demand and never persisted, because they expire.
 */
export async function recordAttachment(
  scope: AttachmentScope,
  attachment: AttachmentRecord
): Promise<string | null> {
  const { data, error } = await scope.client
    .from(ATTACHMENTS)
    .insert({
      workspace_id: scope.workspaceId,
      thread_id: attachment.threadId ?? null,
      filename: attachment.filename,
      media_type: attachment.mediaType,
      size_bytes: attachment.size ?? null,
      storage_path: attachment.storagePath,
      checksum: attachment.checksum ?? null,
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    logger.error("db.record_attachment_failed", errorFields(error));
    return null;
  }
  return data?.id ?? null;
}

export async function signAttachment(
  client: SupabaseClient,
  storagePath: string,
  expiresInSeconds: number
): Promise<string | null> {
  const { data, error } = await client.storage
    .from(MAYA_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data) {
    logger.error("storage.sign_failed", errorFields(error));
    return null;
  }
  return data.signedUrl;
}
