import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { MayaMessage } from "@/lib/maya/tools";

const CONVERSATIONS = "maya_conversations";
const MESSAGES = "maya_messages";
const ATTACHMENTS = "maya_attachments";

export type ConversationSummary = {
  id: string;
  title: string | null;
  updatedAt: string;
};

/** Oppretter samtalen hvis den ikke finnes. No-op uten Supabase. */
export async function ensureConversation(
  conversationId: string,
  title?: string
): Promise<void> {
  const db = getSupabaseAdmin();
  if (!db) {
    return;
  }
  await db.from(CONVERSATIONS).upsert(
    {
      id: conversationId,
      title: title?.slice(0, 120) ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id", ignoreDuplicates: false }
  );
}

/** Lagrer meldinger med strukturerte parts intakt. */
export async function saveMessages(
  conversationId: string,
  messages: MayaMessage[],
  offset = 0
): Promise<void> {
  const db = getSupabaseAdmin();
  if (!db || messages.length === 0) {
    return;
  }

  const rows = messages.map((message, index) => ({
    id: message.id,
    conversation_id: conversationId,
    role: message.role,
    parts: message.parts,
    metadata: message.metadata ?? {},
    position: offset + index,
  }));

  await db.from(MESSAGES).upsert(rows, { onConflict: "id" });
  await db
    .from(CONVERSATIONS)
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

/** Henter hele samtalen med parts slik de ble lagret. */
export async function loadMessages(
  conversationId: string
): Promise<MayaMessage[]> {
  const db = getSupabaseAdmin();
  if (!db) {
    return [];
  }

  const { data, error } = await db
    .from(MESSAGES)
    .select("id, role, parts, metadata")
    .eq("conversation_id", conversationId)
    .order("position", { ascending: true });

  if (error || !data) {
    return [];
  }

  return data.map((row) => ({
    id: row.id as string,
    role: row.role as MayaMessage["role"],
    parts: row.parts as MayaMessage["parts"],
    metadata: row.metadata as MayaMessage["metadata"],
  }));
}

export async function countMessages(conversationId: string): Promise<number> {
  const db = getSupabaseAdmin();
  if (!db) {
    return 0;
  }
  const { count } = await db
    .from(MESSAGES)
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId);
  return count ?? 0;
}

export async function listConversations(
  limit = 20
): Promise<ConversationSummary[]> {
  const db = getSupabaseAdmin();
  if (!db) {
    return [];
  }
  const { data } = await db
    .from(CONVERSATIONS)
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    title: row.title as string | null,
    updatedAt: row.updated_at as string,
  }));
}

export type AttachmentRecord = {
  conversationId?: string | null;
  filename: string;
  mediaType: string;
  size?: number;
  storagePath: string;
  url: string;
};

export async function recordAttachment(
  attachment: AttachmentRecord
): Promise<void> {
  const db = getSupabaseAdmin();
  if (!db) {
    return;
  }
  await db.from(ATTACHMENTS).insert({
    conversation_id: attachment.conversationId ?? null,
    filename: attachment.filename,
    media_type: attachment.mediaType,
    size_bytes: attachment.size ?? null,
    storage_path: attachment.storagePath,
    url: attachment.url,
  });
}
