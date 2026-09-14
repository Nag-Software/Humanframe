"use client";

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";
import { useEveAgent } from "eve/react";
import type { EveMessage } from "eve/react";
import type { UserContent } from "ai";

import { createSupabaseAttachmentAdapter } from "@/lib/maya/attachment-adapter";
import { toThreadMessage } from "@/lib/maya/eve-message-adapter";

/**
 * Bridges eve's durable session to assistant-ui.
 *
 * eve speaks its own NDJSON event stream rather than the AI SDK's UI message
 * stream, so the runtime here is an external store: eve owns the messages and
 * the turn lifecycle, assistant-ui renders them and hands back user intent.
 */
export function EveRuntimeProvider({
  threadId,
  sessionId,
  children,
}: {
  threadId: string;
  /** Existing eve session for this thread, when it has one. */
  sessionId?: string | null;
  children: ReactNode;
}) {
  const agent = useEveAgent({
    initialSession: sessionId ? { sessionId, streamIndex: 0 } : undefined,
    resume: Boolean(sessionId),
  });

  const { send, respond, cancel } = agent;

  // eve mints the session id on the first turn. Supabase owns the thread, so
  // the link is stored once, as soon as it exists.
  const linkedSessionId = useRef(sessionId ?? null);
  const currentSessionId = agent.session?.sessionId ?? null;

  useEffect(() => {
    if (!currentSessionId || linkedSessionId.current === currentSessionId) {
      return;
    }
    linkedSessionId.current = currentSessionId;
    void fetch("/api/assistants/maya/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, sessionId: currentSessionId }),
    });
  }, [currentSessionId, threadId]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      await send(toUserContent(message));
    },
    [send]
  );

  const onRespondToToolApproval = useCallback(
    async ({
      approvalId,
      approved,
      optionId,
      text,
    }: {
      approvalId: string;
      approved: boolean;
      optionId?: string;
      text?: string;
    }) => {
      await respond([
        {
          requestId: approvalId,
          // eve's approval prompt offers `approve` / `cancel`.
          optionId: optionId ?? (approved ? "approve" : "cancel"),
          ...(text ? { text } : {}),
        },
      ]);
    },
    [respond]
  );

  const onCancel = useCallback(async () => {
    await cancel();
  }, [cancel]);

  const attachments = useMemo(
    () => createSupabaseAttachmentAdapter(() => threadId),
    [threadId]
  );

  const runtime = useExternalStoreRuntime<EveMessage>({
    messages: agent.data.messages as EveMessage[],
    isRunning: agent.status === "submitted" || agent.status === "streaming",
    isDisabled: agent.status === "resuming",
    convertMessage: toThreadMessage,
    onNew,
    onCancel,
    onRespondToToolApproval,
    adapters: { attachments },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

/** assistant-ui's composer output → the content shape eve's `send` accepts. */
// UserContent is `string | Array<TextPart | ImagePart | FilePart>`; this is the
// element type of the array branch.
type UserContentPart = Extract<UserContent, unknown[]>[number];

function toUserContent(message: AppendMessage): string | UserContent {
  const content: UserContentPart[] = [];

  const collect = (
    part:
      | { type: string; text?: string; image?: string }
      | { type: string; data?: string; mimeType?: string; filename?: string }
  ) => {
    if (part.type === "text" && "text" in part && part.text !== undefined) {
      content.push({ type: "text", text: part.text });
      return;
    }
    if (part.type === "image" && "image" in part && part.image !== undefined) {
      content.push({ type: "image", image: part.image });
      return;
    }
    if (part.type === "file" && "data" in part && part.data !== undefined) {
      content.push({
        type: "file",
        data: part.data,
        mediaType: part.mimeType ?? "application/octet-stream",
        filename: part.filename,
      });
    }
  };

  for (const part of message.content) {
    collect(part);
  }
  for (const attachment of message.attachments ?? []) {
    for (const part of attachment.content) {
      collect(part);
    }
  }

  const only = content[0];
  if (content.length === 1 && only?.type === "text") {
    return only.text;
  }
  return content;
}
