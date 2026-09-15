import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { TranscriptDelta } from "@/lib/call/turn-assembler";

/**
 * The OpenAI Live adapter.
 *
 * This is the only file in the Call path that knows OpenAI's wire format. It
 * builds the session configuration from Humanframe's own instructions, and it
 * translates provider events into the small neutral shapes the rest of the
 * code speaks. Everything else — binding, context, delegation, transcripts,
 * memory — is written against those shapes, which is what a Tavus adapter will
 * reuse in phase 6.
 *
 * Measured against the API on 2026-09-15, because the older Realtime surface
 * this replaced is close enough to look interchangeable and is not:
 *
 *   POST /v1/realtime/calls  model=gpt-live-1   400 invalid_model
 *                                               "not supported in realtime mode"
 *   POST /v1/live/sessions   model=gpt-live-1   201, session.id + answer
 *
 * The differences that actually bite:
 *
 *  - Live takes JSON, not a multipart form, and answers with
 *    `{session:{id}, transport:{type,sdp}}` rather than a raw SDP body with a
 *    `Location` header.
 *  - There is no `tools` array. Under client delegation the model asks for
 *    backend work with `session.delegation.created`, which carries an id and
 *    no task text, and we decide what that work is from the transcript.
 *  - There is no transcript `completed` event and no `response.done`. Turns
 *    are assembled from deltas; see `lib/call/turn-assembler.ts`.
 *  - Interruption on WebRTC is the model's own VAD cancelling output. The
 *    Realtime WebSocket `conversation.item.truncate` / `audio_end_ms` flow
 *    is a different API. Live does not expose a sample-accurate cursor of
 *    what the user heard, and a transcript delta is not that cursor. The
 *    FaceTime prototype therefore never sends a guessed truncate; it stores
 *    barge-in and unobserved playback as interrupted.
 *
 * One trap worth naming: `/v1/realtime/calls` parses the SDP before it
 * validates the model, so probing it with a throwaway offer reports a bad
 * offer and never reaches the real complaint.
 */

const SESSIONS_ENDPOINT = "https://api.openai.com/v1/live/sessions";
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * The model and voice, read through the validated environment so the default
 * lives in exactly one place — a second literal default here is how
 * `CALL_MODEL` briefly disagreed with itself.
 */
export function liveModel(): string {
  return serverEnv().CALL_MODEL;
}

export function liveVoice(): string {
  return serverEnv().CALL_VOICE;
}

export type LiveSessionConfig = Record<string, unknown>;

/**
 * Everything the model is allowed to be, decided server-side.
 *
 * Note what is not here: no database handle, no credentials, no workspace id.
 * The model is given words and a delegation target; the scope the backend work
 * runs in lives in the call binding on our side, where the model cannot reach
 * it.
 *
 * `delegation: client` is the whole reason a call can do what chat can. The
 * alternative — responses delegation — would mean declaring a second tool
 * surface to the provider and maintaining it beside Maya's real one. Here the
 * provider asks us, and we answer with eve.
 */
export function liveSessionConfig(input: {
  instructions: string;
}): LiveSessionConfig {
  return {
    model: liveModel(),
    instructions: input.instructions,
    delegation: { type: "client" },
    audio: { output: { voice: liveVoice() } },
  };
}

export type LiveAnswer = {
  answerSdp: string;
  providerCallId: string;
};

/**
 * Trades the browser's SDP offer for an answer.
 *
 * The permanent key is used here, on the server, and never leaves it: the
 * browser receives an SDP answer, which authorises exactly one peer connection
 * to one already-configured session and nothing else.
 */
export async function createLiveSession(input: {
  offerSdp: string;
  session: LiveSessionConfig;
}): Promise<LiveAnswer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for Call");
  }

  const response = await fetch(SESSIONS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session: input.session,
      transport: { type: "webrtc", sdp: input.offerSdp },
    }),
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
    throw new Error(`Live session rejected: ${response.status}`);
  }

  const body = (await response.json().catch(() => null)) as {
    session?: { id?: string };
    transport?: { sdp?: string };
  } | null;

  const providerCallId = body?.session?.id ?? "";
  const answerSdp = body?.transport?.sdp ?? "";

  if (!providerCallId || !answerSdp) {
    throw new Error("Live session returned no answer");
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

export type LiveEvent = {
  type?: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  delegation?: { id?: string; type?: string; target?: string };
};

/**
 * Provider event → one transcript fragment.
 *
 * Both speakers arrive the same way and differ only in the event name, so the
 * role is read from the name rather than from anything inside the payload.
 */
export function transcriptDeltaFromEvent(
  event: LiveEvent
): TranscriptDelta | null {
  const role =
    event.type === "session.input_transcript.delta"
      ? ("user" as const)
      : event.type === "session.output_transcript.delta"
        ? ("assistant" as const)
        : null;

  if (!role || typeof event.delta !== "string" || event.delta.length === 0) {
    return null;
  }

  const startMs = typeof event.start_ms === "number" ? event.start_ms : 0;
  const endMs = typeof event.end_ms === "number" ? event.end_ms : startMs;

  return { role, text: event.delta, startMs, endMs };
}

/**
 * Provider event → a request for backend work.
 *
 * The event carries an id and nothing else: no task text, no arguments. What
 * the work *is* comes from the transcript, which is why the assembler keeps
 * the turn still being spoken.
 */
export function delegationFromEvent(
  event: LiveEvent
): { delegationId: string } | null {
  if (event.type !== "session.delegation.created") {
    return null;
  }

  const delegation = event.delegation;
  if (!delegation?.id || delegation.target !== "client") {
    return null;
  }

  return { delegationId: delegation.id };
}

/**
 * What Maya should say, handed back to the session she asked from.
 *
 * The model is trained to paraphrase this rather than read it out, so it is
 * written as a fact, not as a line of dialogue. `session.thinking.append` is
 * the silent sibling: same shape, but context she can use without speaking it.
 */
export function commentaryEvent(input: {
  delegationId: string;
  content: string;
  eventId: string;
}): Record<string, unknown> {
  return {
    type: "session.commentary.append",
    event_id: input.eventId,
    delegation_id: input.delegationId,
    content: input.content,
  };
}

export function thinkingEvent(input: {
  content: string;
  eventId: string;
  delegationId?: string | null;
}): Record<string, unknown> {
  return {
    type: "session.thinking.append",
    event_id: input.eventId,
    delegation_id: input.delegationId ?? null,
    content: input.content,
  };
}
