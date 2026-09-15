"use client";

import { useMemo, type ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEveAgentRuntime } from "@assistant-ui/eve";

import { RuntimeCapabilitiesProvider } from "@/components/maya/runtime-capabilities";
import { createSupabaseAttachmentAdapter } from "@/lib/maya/attachment-adapter";

/**
 * Binds an existing eve session to assistant-ui through the official adapter.
 *
 * Humanframe still owns conversation identity: the session is created by
 * /api/assistants/maya/session, which claims the Supabase thread the URL
 * carries. This component only attaches to the session that thread already
 * has, so eve's session id stays internal.
 *
 * eve has no reload or branch semantics, and the adapter only wires `onReload`
 * for locally staged (failed) sends, so those controls are hidden rather than
 * offered and broken.
 */
export function EveRuntimeProvider({
  threadId,
  sessionId,
  children,
}: {
  threadId: string;
  sessionId: string;
  children: ReactNode;
}) {
  const attachments = useMemo(
    () => createSupabaseAttachmentAdapter(() => threadId),
    [threadId]
  );

  const runtime = useEveAgentRuntime({
    initialSession: { sessionId, streamIndex: 0 },
    resume: true,
    adapters: { attachments },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RuntimeCapabilitiesProvider
        capabilities={{ reload: false, edit: false, branching: false }}
      >
        {children}
      </RuntimeCapabilitiesProvider>
    </AssistantRuntimeProvider>
  );
}
