import { Client, type ClientSession } from "eve/client";
import type { UserContent } from "ai";

import { serverEnv } from "@/lib/env";
import type {
  AgentRuntime,
  ApprovalDecision,
  ExternalEvent,
  RuntimeChannel,
  RuntimeEvent,
  RuntimeInput,
  RuntimeSession,
} from "@/server/agent/runtime/agent-runtime";

/**
 * The only server-side module that imports eve. Everything else goes through
 * AgentRuntime.
 */
class EveRuntime implements AgentRuntime {
  readonly #client: Client;

  constructor(host: string) {
    this.#client = new Client({ host });
  }

  async startSession(input: {
    workspaceId: string;
    assistantId: string;
    threadId: string;
    channel: RuntimeChannel;
    message: RuntimeInput[];
  }): Promise<RuntimeSession> {
    const { session } = await this.#client.sessions.create({
      message: toUserContent(input.message),
    });

    return {
      sessionId: session.state.sessionId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      channel: input.channel,
    };
  }

  async continueSession(input: {
    sessionId: string;
    message: RuntimeInput[];
    turnPolicy?: "queue" | "steer";
  }): Promise<void> {
    const session = this.#session(input.sessionId);
    await session.send(toUserContent(input.message), {
      turnPolicy: input.turnPolicy,
    });
  }

  async *streamRun(input: {
    sessionId: string;
    fromIndex?: number;
    signal?: AbortSignal;
  }): AsyncIterable<RuntimeEvent> {
    const session = this.#session(input.sessionId, input.fromIndex);

    for await (const event of session.stream({ signal: input.signal })) {
      const mapped = toRuntimeEvent(event);
      if (mapped) {
        yield mapped;
      }
    }
  }

  async cancelRun(input: { sessionId: string }): Promise<void> {
    await this.#session(input.sessionId).cancel();
  }

  async resumeRun(input: { sessionId: string }): Promise<{ streamIndex: number }> {
    const snapshot = await this.#session(input.sessionId).snapshot();
    return { streamIndex: snapshot.events.length };
  }

  async submitApproval(input: {
    sessionId: string;
    requestId: string;
    decision: ApprovalDecision;
  }): Promise<void> {
    const optionId =
      input.decision.decision === "approve"
        ? (input.decision.optionId ?? "approve")
        : "deny";

    await this.#session(input.sessionId).respond([
      {
        requestId: input.requestId,
        optionId,
        ...(input.decision.decision === "approve" && input.decision.text
          ? { text: input.decision.text }
          : {}),
      },
    ]);
  }

  /**
   * Wakes the agent from outside a user turn: a deadline, a webhook, a
   * heartbeat. It reuses the thread's session when there is one, so Maya keeps
   * her context instead of starting over.
   */
  async handleExternalEvent(input: {
    workspaceId: string;
    assistantId: string;
    threadId: string;
    sessionId?: string;
    event: ExternalEvent;
  }): Promise<RuntimeSession> {
    const message: RuntimeInput[] = [
      { type: "text", text: input.event.message },
    ];

    if (input.sessionId) {
      await this.continueSession({
        sessionId: input.sessionId,
        message,
        turnPolicy: "queue",
      });
      return {
        sessionId: input.sessionId,
        threadId: input.threadId,
        workspaceId: input.workspaceId,
        assistantId: input.assistantId,
        channel: "system",
      };
    }

    return this.startSession({
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      threadId: input.threadId,
      channel: "system",
      message,
    });
  }

  #session(sessionId: string, streamIndex = 0): ClientSession {
    return this.#client.sessions.attach(sessionId, { streamIndex });
  }
}

function toUserContent(parts: RuntimeInput[]): string | UserContent {
  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text;
  }

  return parts.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : {
          type: "file" as const,
          data: part.url,
          mediaType: part.mediaType,
          filename: part.filename,
        }
  );
}

type StreamEvent = { type: string; data?: Record<string, unknown> };

/** eve's wire events → Humanframe's channel-neutral events. */
function toRuntimeEvent(event: StreamEvent): RuntimeEvent | null {
  const data = event.data ?? {};

  switch (event.type) {
    case "message.appended":
      return { type: "text.delta", text: String(data.messageDelta ?? "") };

    case "message.completed":
      return data.message == null
        ? null
        : { type: "text.complete", text: String(data.message) };

    case "reasoning.appended":
      return { type: "reasoning.delta", text: String(data.reasoningDelta ?? "") };

    case "actions.requested": {
      const actions = (data.actions ?? []) as {
        callId?: string;
        toolName?: string;
        input?: unknown;
      }[];
      const first = actions[0];
      if (!first?.callId || !first.toolName) {
        return null;
      }
      return {
        type: "tool.call",
        callId: first.callId,
        name: first.toolName,
        input: first.input,
      };
    }

    case "action.result":
      return {
        type: "tool.result",
        callId: String(data.callId ?? ""),
        output: data.output,
        isError: Boolean(data.isError),
      };

    case "input.requested": {
      const requests = (data.requests ?? []) as {
        requestId?: string;
        prompt?: string;
        action?: { callId?: string; toolName?: string; input?: unknown };
      }[];
      const request = requests[0];
      if (!request?.requestId) {
        return null;
      }
      return {
        type: "approval.requested",
        requestId: request.requestId,
        callId: request.action?.callId ?? "",
        toolName: request.action?.toolName ?? "",
        input: request.action?.input,
        prompt: request.prompt ?? "",
        risk: "execute_with_approval",
      };
    }

    case "turn.started":
      return { type: "run.status", status: "started", turnId: String(data.turnId ?? "") };
    case "session.waiting":
      return { type: "run.status", status: "waiting" };
    case "turn.completed":
      return { type: "run.status", status: "completed", turnId: String(data.turnId ?? "") };
    case "turn.cancelled":
      return { type: "run.status", status: "cancelled" };
    case "turn.failed":
    case "session.failed":
      return {
        type: "run.status",
        status: "failed",
        error: {
          code: String(data.code ?? "unknown"),
          message: String(data.message ?? "The run failed"),
        },
      };

    default:
      return null;
  }
}

let runtime: AgentRuntime | null = null;

/** Same-origin in the app; the host is only explicit in scripts and tests. */
export function getAgentRuntime(): AgentRuntime {
  runtime ??= new EveRuntime(serverEnv().APP_URL);
  return runtime;
}
