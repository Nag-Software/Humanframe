"use client";

import { useMemo, useState } from "react";

import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { CallOverlay } from "@/components/maya/call/call-overlay";
import { FacetimeOverlay } from "@/components/maya/facetime/facetime-overlay";
import { EveRuntimeProvider } from "@/components/maya/eve-runtime-provider";
import { MayaHeader, type MayaCallHandlers } from "@/components/maya/maya-header";
import { MayaRuntimeProvider } from "@/components/maya/maya-runtime-provider";
import { MayaToolUIs } from "@/components/maya/tool-ui";
import { MayaWelcome } from "@/components/maya/maya-welcome";
import { NewConversation } from "@/components/maya/new-conversation";
import { RuntimeCapabilitiesProvider } from "@/components/maya/runtime-capabilities";
import { publicEnv } from "@/lib/env";
import type { MayaMessage } from "@/lib/maya/tools";

export function MayaChat({
  threadId,
  initialMessages,
  eveSessionId,
  onVoiceCall,
  onVideoCall,
}: {
  /** Null on eve until the first message creates the thread server-side. */
  threadId: string | null;
  initialMessages: MayaMessage[];
  /** Cursor for the previous page of history, when the thread has one. */
  olderMessagesCursor?: string | null;
  /** The eve session this thread already runs on, when it has one. */
  eveSessionId?: string | null;
} & MayaCallHandlers) {
  const components = useMemo(() => ({ Welcome: MayaWelcome }), []);
  const runsOnEve = publicEnv.NEXT_PUBLIC_MAYA_RUNTIME === "eve";
  const [inCall, setInCall] = useState(false);
  const [inFacetime, setInFacetime] = useState(false);

  // The call button is an affordance only: the server refuses to start a call
  // unless CALL_ENABLED is set there too.
  const callEnabled = publicEnv.NEXT_PUBLIC_CALL_ENABLED === "true";
  const facetimeEnabled = publicEnv.NEXT_PUBLIC_FACETIME_PROTOTYPE === "true";
  const startCall = callEnabled
    ? onVoiceCall ?? (() => setInCall(true))
    : onVoiceCall;
  const startFacetime = facetimeEnabled
    ? onVideoCall ?? (() => setInFacetime(true))
    : onVideoCall;

  const shell = (body: React.ReactNode) => (
    <div className="flex h-[calc(100svh-4rem)] flex-col">
      <MayaHeader onVoiceCall={startCall} onVideoCall={startFacetime} />
      <div className="min-h-0 flex-1">{body}</div>
      {inCall ? (
        <CallOverlay threadId={threadId} onClose={() => setInCall(false)} />
      ) : null}
      {inFacetime ? (
        <FacetimeOverlay
          threadId={threadId}
          onClose={() => setInFacetime(false)}
        />
      ) : null}
    </div>
  );

  if (runsOnEve) {
    // No session yet: the conversation has not been created server-side.
    if (!threadId || !eveSessionId) {
      return shell(<NewConversation />);
    }

    return (
      <EveRuntimeProvider threadId={threadId} sessionId={eveSessionId}>
        <MayaToolUIs />
        {shell(<Thread components={components} />)}
      </EveRuntimeProvider>
    );
  }

  return (
    <MayaRuntimeProvider
      threadId={threadId ?? ""}
      initialMessages={initialMessages}
    >
      <RuntimeCapabilitiesProvider
        capabilities={{ reload: true, edit: true, branching: true }}
      >
        <MayaToolUIs />
        {shell(<Thread components={components} />)}
      </RuntimeCapabilitiesProvider>
    </MayaRuntimeProvider>
  );
}
