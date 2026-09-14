"use client";

import { useMemo } from "react";

import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { EveRuntimeProvider } from "@/components/maya/eve-runtime-provider";
import { MayaHeader, type MayaCallHandlers } from "@/components/maya/maya-header";
import { MayaRuntimeProvider } from "@/components/maya/maya-runtime-provider";
import { publicEnv } from "@/lib/env";
import { MayaToolUIs } from "@/components/maya/tool-ui";
import { MayaWelcome } from "@/components/maya/maya-welcome";
import type { MayaMessage } from "@/lib/maya/tools";

export function MayaChat({
  threadId,
  initialMessages,
  eveSessionId,
  onVoiceCall,
  onVideoCall,
}: {
  threadId: string;
  initialMessages: MayaMessage[];
  /** Cursor for the previous page of history, when the thread has one. */
  olderMessagesCursor?: string | null;
  /** The eve session this thread already runs on, when it has one. */
  eveSessionId?: string | null;
} & MayaCallHandlers) {
  const components = useMemo(() => ({ Welcome: MayaWelcome }), []);

  const body = (
    <>
      <MayaToolUIs />
      <div className="flex h-[calc(100svh-4rem)] flex-col">
        <MayaHeader onVoiceCall={onVoiceCall} onVideoCall={onVideoCall} />
        <div className="min-h-0 flex-1">
          <Thread components={components} />
        </div>
      </div>
    </>
  );

  // Both runtimes render the same thread; only the transport differs.
  if (publicEnv.NEXT_PUBLIC_MAYA_RUNTIME === "eve") {
    return (
      <EveRuntimeProvider threadId={threadId} sessionId={eveSessionId}>
        {body}
      </EveRuntimeProvider>
    );
  }

  return (
    <MayaRuntimeProvider threadId={threadId} initialMessages={initialMessages}>
      {body}
    </MayaRuntimeProvider>
  );
}
