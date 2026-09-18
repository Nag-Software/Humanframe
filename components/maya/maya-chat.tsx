"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { CallOverlay } from "@/components/maya/call/call-overlay";
import { FacetimeOverlay } from "@/components/maya/facetime/facetime-overlay";
import { EveRuntimeProvider } from "@/components/maya/eve-runtime-provider";
import {
  MayaHeader,
  type Holding,
  type MayaCallHandlers,
} from "@/components/maya/maya-header";
import { MayaRuntimeProvider } from "@/components/maya/maya-runtime-provider";
import { MayaToolUIs } from "@/components/maya/tool-ui";
import { MayaWelcome } from "@/components/maya/maya-welcome";
import { NewConversation } from "@/components/maya/new-conversation";
import { RuntimeCapabilitiesProvider } from "@/components/maya/runtime-capabilities";
import { publicEnv } from "@/lib/env";
import type { MayaMessage } from "@/lib/maya/tools";

type CallKind = "none" | "voice" | "video";

/** `?call=voice` or `?call=video` starts a call on arrival — her profile links here. */
const CALL_QUERY = "call";

export function MayaChat({
  threadId,
  initialMessages,
  eveSessionId,
  holding,
  openable = false,
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
  holding: Holding;
  /** True when Maya has something to open the day with (see the session route). */
  openable?: boolean;
} & MayaCallHandlers) {
  const components = useMemo(() => ({ Welcome: MayaWelcome }), []);
  const router = useRouter();
  const searchParams = useSearchParams();
  const runsOnEve = publicEnv.NEXT_PUBLIC_MAYA_RUNTIME === "eve";
  const [call, setCall] = useState<CallKind>("none");
  const [minimized, setMinimized] = useState(false);

  // The call button is an affordance only: the server refuses to start a call
  // unless CALL_ENABLED is set there too.
  const callEnabled = publicEnv.NEXT_PUBLIC_CALL_ENABLED === "true";
  const facetimeEnabled = publicEnv.NEXT_PUBLIC_FACETIME_PROTOTYPE === "true";

  const requested = searchParams.get(CALL_QUERY);
  useEffect(() => {
    if (requested !== "voice" && requested !== "video") {
      return;
    }
    const allowed =
      (requested === "voice" && callEnabled) ||
      (requested === "video" && facetimeEnabled);
    // The query is consumed once: a refresh must not ring her again.
    const url = new URL(window.location.href);
    url.searchParams.delete(CALL_QUERY);
    router.replace(`${url.pathname}${url.search}`);
    if (allowed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- URL after mount
      setCall(requested);
      setMinimized(false);
    }
  }, [requested, callEnabled, facetimeEnabled, router]);

  const startCall = callEnabled
    ? onVoiceCall ??
      (() => {
        setMinimized(false);
        setCall("voice");
      })
    : onVoiceCall;
  const startFacetime = facetimeEnabled
    ? onVideoCall ?? (() => setCall("video"))
    : onVideoCall;

  const endCall = () => {
    setCall("none");
    setMinimized(false);
  };

  const shell = (body: React.ReactNode, live: boolean) => (
    <div className="flex h-svh flex-col">
      <MayaHeader
        onVoiceCall={call === "none" ? startCall : undefined}
        onVideoCall={call === "none" ? startFacetime : undefined}
        holding={holding}
        live={live}
      />
      {call === "voice" ? (
        <CallOverlay
          threadId={threadId}
          minimized={minimized}
          onMinimize={() => setMinimized(true)}
          onRestore={() => setMinimized(false)}
          onClose={endCall}
        />
      ) : null}
      <div className="min-h-0 flex-1">{body}</div>
      {call === "video" ? (
        <FacetimeOverlay threadId={threadId} onClose={endCall} />
      ) : null}
    </div>
  );

  if (runsOnEve) {
    // No session yet: the conversation has not been created server-side.
    if (!threadId || !eveSessionId) {
      return shell(<NewConversation openable={openable} />, false);
    }

    return (
      <EveRuntimeProvider threadId={threadId} sessionId={eveSessionId}>
        <MayaToolUIs />
        {shell(<Thread components={components} />, true)}
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
        {shell(<Thread components={components} />, true)}
      </RuntimeCapabilitiesProvider>
    </MayaRuntimeProvider>
  );
}
