"use client";

import { useMemo, type ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";

import { createSupabaseAttachmentAdapter } from "@/lib/maya/attachment-adapter";
import type { MayaMessage } from "@/lib/maya/tools";

export function MayaRuntimeProvider({
  threadId,
  initialMessages,
  children,
}: {
  threadId: string;
  initialMessages: MayaMessage[];
  children: ReactNode;
}) {
  const transport = useMemo(
    () =>
      new AssistantChatTransport<MayaMessage>({
        api: "/api/assistants/maya/chat",
        body: { threadId },
      }),
    [threadId]
  );

  const attachments = useMemo(
    () => createSupabaseAttachmentAdapter(() => threadId),
    [threadId]
  );

  const runtime = useChatRuntime<MayaMessage>({
    id: threadId,
    transport,
    messages: initialMessages,
    adapters: { attachments },
    // Etter at brukeren har godkjent et verktøykall sendes turen videre selv.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
