import type {
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";

type UploadResponse = {
  url: string;
  filename: string;
  mediaType?: string;
  size?: number;
};

const isImage = (file: File) => file.type.startsWith("image/");

/**
 * Laster vedlegg opp til Supabase Storage via /api/assistants/maya/upload og
 * gjør dem om til image-/file-parts som modellen kan lese.
 */
export function createSupabaseAttachmentAdapter(
  getThreadId: () => string | undefined
): AttachmentAdapter {
  return {
    accept:
      "image/*,application/pdf,text/plain,text/markdown,text/csv,application/json",

    async add({ file }): Promise<PendingAttachment> {
      return {
        id: crypto.randomUUID(),
        type: isImage(file) ? "image" : "document",
        name: file.name,
        contentType: file.type,
        file,
        status: { type: "requires-action", reason: "composer-send" },
      };
    },

    async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
      const body = new FormData();
      body.append("file", attachment.file);
      const threadId = getThreadId();
      if (threadId) {
        body.append("threadId", threadId);
      }

      const response = await fetch("/api/assistants/maya/upload", {
        method: "POST",
        body,
      });
      if (!response.ok) {
        throw new Error("Kunne ikke laste opp vedlegget");
      }
      const uploaded = (await response.json()) as UploadResponse;

      return {
        ...attachment,
        status: { type: "complete" },
        content: isImage(attachment.file)
          ? [
              {
                type: "image",
                image: uploaded.url,
                filename: uploaded.filename,
              },
            ]
          : [
              {
                type: "file",
                data: uploaded.url,
                mimeType:
                  uploaded.mediaType ??
                  attachment.contentType ??
                  "application/octet-stream",
                filename: uploaded.filename,
                sourceType: "url",
              },
            ],
      };
    },

    async remove(): Promise<void> {
      // Files stay in Storage; the attachments row is the record of truth.
    },
  };
}
