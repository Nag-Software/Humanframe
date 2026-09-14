"use client";

import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
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
  /** Null until the first message has created the thread server-side. */
  threadId?: string | null;
  /** Existing eve session for this thread, when it has one. */
  sessionId?: string | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const agent = useEveAgent({
    initialSession: sessionId ? { sessionId, streamIndex: 0 } : undefined,
    resume: Boolean(sessionId),
  });

  const { send, respond, cancel } = agent;
  const starting = useRef(false);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const content = toUserContent(message);

      if (sessionId) {
        await send(content);
        return;
      }

      // First message of a new conversation: the server creates the eve
      // session and claims the thread that owns it, then the URL adopts the
      // thread id it minted. The eve session id stays private.
      if (starting.current) {
        return;
      }
      starting.current = true;

      try {
        const response = await fetch("/api/assistants/maya/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: typeof content === "string" ? content : firstText(content),
          }),
        });

        if (!response.ok) {
          throw new Error(`Session start failed: ${response.status}`);
        }

        const created = (await response.json()) as { threadId: string };
        router.replace(`/assistants/maya?t=${created.threadId}`);
      } finally {
        starting.current = false;
      }
    },
    [router, send, sessionId]
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
    () => createSupabaseAttachmentAdapter(() => threadId ?? undefined),
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

function firstText(content: UserContent): string {
  if (typeof content === "string") {
    return content;
  }
  const text = content.find((part) => part.type === "text");
  return text && "text" in text ? text.text : "";
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
