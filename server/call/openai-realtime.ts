import { logger } from "@/lib/logger";
import type { CallToolDefinition } from "@/server/call/tools";
import type { CallTurn } from "@/server/call/transcript";

/**
 * The OpenAI Realtime adapter.
 *
 * This is the only file in the Call path that knows OpenAI's wire format. It
 * does two things: it builds the session configuration from Humanframe's own
 * instructions and tool list, and it translates provider events into the small
 * neutral shapes the rest of the code speaks. Everything else — binding,
 * context, tool execution, transcripts, memory — is written against those
 * shapes, which is what a Tavus adapter will reuse in phase 6.
 *
 * Verified against the API on 2026-09-15: `gpt-realtime-2.1` is a live model
 * id, `POST /v1/realtime/calls` accepts an SDP offer with a session object and
 * answers with `Location: /v1/realtime/calls/{call_id}`.
 */
export const REALTIME_MODEL = process.env.CALL_MODEL?.trim() || "gpt-realtime-2.1";
export const REALTIME_VOICE = process.env.CALL_VOICE?.trim() || "marin";

const CALLS_ENDPOINT = "https://api.openai.com/v1/realtime/calls";
const CONNECT_TIMEOUT_MS = 20_000;

export type RealtimeSessionConfig = Record<string, unknown>;

/**
 * Everything the model is allowed to be, decided server-side.
 *
 * Note what is not here: no database handle, no credentials, no workspace id.
 * The model is given words and tool names; the scope those tools run in lives
 * in the call binding on our side, where the model cannot reach it.
 */
export function realtimeSessionConfig(input: {
  instructions: string;
  tools: readonly CallToolDefinition[];
}): RealtimeSessionConfig {
  return {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions: input.instructions,
    audio: {
      input: {
        // A transcript of what the user said, so the conversation can be
        // persisted and remembered. No audio is stored.
        transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: { type: "semantic_vad", interrupt_response: true },
      },
      output: { voice: REALTIME_VOICE },
    },
    tools: input.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    tool_choice: "auto",
  };
}

export type RealtimeAnswer = {
  answerSdp: string;
  providerCallId: string;
};

/**
 * Trades the browser's SDP offer for an answer.
 *
 * The permanent key is used here, on the server, and never leaves it: the
 * browser receives an SDP answer, which authorises exactly one peer connection
 * to one already-configured session and nothing else. No ephemeral key is
 * minted, so there is no client credential to leak or replay either.
 */
export async function createRealtimeCall(input: {
  offerSdp: string;
  session: RealtimeSessionConfig;
}): Promise<RealtimeAnswer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for Call");
  }

  const form = new FormData();
  form.set("sdp", input.offerSdp);
  form.set("session", JSON.stringify(input.session));

  const response = await fetch(CALLS_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // The body can echo the session configuration; log the status and code
    // only, never the payload and never the key.
    logger.error("call.provider_rejected", {
      status: response.status,
      code: safeCode(detail),
    });
    throw new Error(`Realtime call rejected: ${response.status}`);
  }

  const location = response.headers.get("location") ?? "";
  const providerCallId = location.split("/").filter(Boolean).pop() ?? "";
  const answerSdp = await response.text();

  if (!providerCallId || !answerSdp) {
    throw new Error("Realtime call returned no answer");
  }

  return { answerSdp, providerCallId };
}

function safeCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string } };
    return parsed.error?.code ?? "unknown";
  } catch {
    return "unparseable";
  }
}

/**
 * Provider event → neutral turn.
 *
 * Only finished turns produce anything. Deltas are explicitly ignored, so a
 * partial transcript can never become a message or trigger an action; the
 * caller relays whole events and this decides which ones mean something.
 */
export function turnFromEvent(event: {
  type?: string;
  item_id?: string;
  transcript?: string;
  item?: { id?: string; role?: string; status?: string; content?: unknown[] };
}): CallTurn | null {
  // What the user said: emitted once, when transcription of their turn ends.
  if (
    event.type === "conversation.item.input_audio_transcription.completed" &&
    typeof event.item_id === "string" &&
    typeof event.transcript === "string"
  ) {
    return {
      sourceId: event.item_id,
      role: "user",
      text: event.transcript.trim(),
    } satisfies CallTurn;
  }

  // What Maya said: emitted when the item is done, whether she finished the
  // sentence or the user talked over her.
  if (event.type === "conversation.item.done") {
    const item = event.item;
    const itemId = item?.id;
    if (!itemId || item.role !== "assistant") {
      return null;
    }
    const text = assistantText(item.content).trim();
    if (text.length === 0) {
      return null;
    }
    return {
      sourceId: itemId,
      role: "assistant",
      text,
      // "incomplete" is the provider's word for a response the user cut off.
      interrupted: item.status === "incomplete",
    };
  }

  return null;
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const record = part as { transcript?: unknown; text?: unknown };
      if (typeof record.transcript === "string") return record.transcript;
      if (typeof record.text === "string") return record.text;
      return "";
    })
    .join(" ");
}

/**
 * Provider event → neutral tool call.
 *
 * `response.function_call_arguments.done` is the only event that carries a
 * complete argument object; the `.delta` stream is ignored for the same reason
 * partial transcripts are — half an argument is not an instruction.
 */
export function toolCallFromEvent(event: {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
}): { name: string; callId: string; args: unknown } | null {
  if (
    event.type !== "response.function_call_arguments.done" ||
    typeof event.name !== "string" ||
    typeof event.call_id !== "string"
  ) {
    return null;
  }

  let args: unknown = {};
  try {
    args = event.arguments ? JSON.parse(event.arguments) : {};
  } catch {
    args = {};
  }

  return { name: event.name, callId: event.call_id, args };
}
