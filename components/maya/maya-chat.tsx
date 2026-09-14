"use client";

import { useMemo } from "react";

import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { MayaHeader, type MayaCallHandlers } from "@/components/maya/maya-header";
import { MayaRuntimeProvider } from "@/components/maya/maya-runtime-provider";
import { MayaToolUIs } from "@/components/maya/tool-ui";
import { MayaWelcome } from "@/components/maya/maya-welcome";
import type { MayaMessage } from "@/lib/maya/tools";

export function MayaChat({
  conversationId,
  initialMessages,
  onVoiceCall,
  onVideoCall,
}: {
  conversationId: string;
  initialMessages: MayaMessage[];
} & MayaCallHandlers) {
  const components = useMemo(() => ({ Welcome: MayaWelcome }), []);

  return (
    <MayaRuntimeProvider
      conversationId={conversationId}
      initialMessages={initialMessages}
    >
      <MayaToolUIs />
      <div className="flex h-[calc(100svh-4rem)] flex-col">
        <MayaHeader onVoiceCall={onVoiceCall} onVideoCall={onVideoCall} />
        <div className="min-h-0 flex-1">
          <Thread components={components} />
        </div>
      </div>
    </MayaRuntimeProvider>
  );
}
