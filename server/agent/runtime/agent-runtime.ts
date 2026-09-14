/**
 * The runtime seam.
 *
 * eve is in preview, so nothing outside `eve-runtime.ts` on the server imports
 * it. Channels (chat, voice, video), workflows and background events speak this
 * interface, which can be re-implemented on the AI SDK plus Vercel Workflows
 * without touching its callers.
 *
 * The browser chat is the one documented exception: it talks to the same-origin
 * eve routes through `useEveAgent`, because proxying a durable stream through
 * the app would buy nothing.
 */

export type RuntimeChannel = "chat" | "live" | "facetime" | "system";

export type RiskLevel =
  | "read"
  | "prepare"
  | "execute_with_approval"
  | "autonomous";

export type RuntimeSession = {
  sessionId: string;
  threadId: string;
  workspaceId: string;
  assistantId: string;
  channel: RuntimeChannel;
};

export type RuntimeInput =
  | { type: "text"; text: string }
  | { type: "file"; url: string; mediaType: string; filename?: string };

export type RuntimeEvent =
  | { type: "text.delta"; text: string }
  | { type: "text.complete"; text: string; messageId?: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.call"; callId: string; name: string; input: unknown }
  | { type: "tool.result"; callId: string; output: unknown; isError?: boolean }
  | {
      type: "approval.requested";
      requestId: string;
      callId: string;
      toolName: string;
      input: unknown;
      prompt: string;
      risk: RiskLevel;
    }
  | {
      type: "run.status";
      status: "started" | "waiting" | "completed" | "failed" | "cancelled";
      turnId?: string;
      error?: { code: string; message: string };
    };

export type ApprovalDecision =
  | { decision: "approve"; optionId?: string; text?: string }
  | { decision: "deny"; reason?: string };

/** An outside signal that should wake Maya: a deadline, a webhook, a reminder. */
export type ExternalEvent = {
  kind: string;
  message: string;
  threadId?: string;
  payload?: Record<string, unknown>;
};

export interface AgentRuntime {
  startSession(input: {
    workspaceId: string;
    assistantId: string;
    threadId: string;
    channel: RuntimeChannel;
    message: RuntimeInput[];
  }): Promise<RuntimeSession>;

  continueSession(input: {
    sessionId: string;
    message: RuntimeInput[];
    turnPolicy?: "queue" | "steer";
  }): Promise<void>;

  streamRun(input: {
    sessionId: string;
    fromIndex?: number;
    signal?: AbortSignal;
  }): AsyncIterable<RuntimeEvent>;

  cancelRun(input: { sessionId: string }): Promise<void>;

  resumeRun(input: { sessionId: string }): Promise<{ streamIndex: number }>;

  submitApproval(input: {
    sessionId: string;
    requestId: string;
    decision: ApprovalDecision;
  }): Promise<void>;

  handleExternalEvent(input: {
    workspaceId: string;
    assistantId: string;
    threadId: string;
    sessionId?: string;
    event: ExternalEvent;
  }): Promise<RuntimeSession>;
}
