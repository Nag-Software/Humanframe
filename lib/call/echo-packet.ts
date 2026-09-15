/**
 * Tavus audio-echo packets, sized against Daily's documented limit.
 *
 * Daily `sendAppMessage` is a JSON object whose serialised form must stay
 * within 4 KB. That bound is the whole envelope — modality, inference id,
 * conversation id, base64 audio — not the PCM alone. `sendAppMessage`
 * returning is not proof Tavus consumed the chunk; it is only proof we
 * handed Daily a payload that fit.
 *
 * Chunk duration is 20 ms of PCM16LE mono at 16 kHz. Measured 2026-09-15
 * in-process (no Daily room), 36-character conversation id, inference id
 * `inf`, JSON.stringify of the whole envelope:
 *
 *   20 ms  16 kHz   1076 B   fits
 *   40 ms  16 kHz   1928 B   fits
 *  100 ms  16 kHz   4488 B   does not fit
 *  200 ms  24 kHz  13020 B   does not fit
 *  interrupt               126 B
 *
 * A 20 ms cadence is 50 messages/s if the tap keeps up. 100 ms at 16 kHz
 * already crosses Daily's 4 KB cap, so we do not "just send longer chunks".
 * We stay at 20 ms so a longer conversation id or a future field cannot
 * silently cross the line. sendAppMessage returning is not consumption.
 *
 * Encoding is raw signed 16-bit little-endian PCM, no RIFF/WAVE header.
 * That is what Pipecat's Tavus client sends and what the OpenAPI schema
 * describes as "PCM or pipeline-specific encoding". Sample rate is sent
 * explicitly on every chunk because the server default is 16000 and we
 * must not depend on it.
 */

export const DAILY_APP_MESSAGE_LIMIT_BYTES = 4096;
export const ECHO_SAMPLE_RATE = 16_000;
export const ECHO_CHUNK_MS = 20;

export type EchoAudioMessage = {
  message_type: "conversation";
  event_type: "conversation.echo";
  conversation_id: string;
  properties: {
    modality: "audio";
    audio: string;
    sample_rate: number;
    inference_id: string;
    done: boolean;
  };
};

export type EchoPacket = {
  message: EchoAudioMessage;
  bytes: number;
};

export function pcm16BytesFor(ms: number, sampleRate = ECHO_SAMPLE_RATE): number {
  return Math.round(sampleRate * (ms / 1000)) * 2;
}

export function encodePcm16Base64(pcm: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(pcm).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < pcm.length; i += chunk) {
    binary += String.fromCharCode(...pcm.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function echoAudioMessage(input: {
  conversationId: string;
  pcm: Uint8Array;
  sampleRate?: number;
  inferenceId: string;
  done: boolean;
}): EchoPacket {
  const message: EchoAudioMessage = {
    message_type: "conversation",
    event_type: "conversation.echo",
    conversation_id: input.conversationId,
    properties: {
      modality: "audio",
      audio: encodePcm16Base64(input.pcm),
      sample_rate: input.sampleRate ?? ECHO_SAMPLE_RATE,
      inference_id: input.inferenceId,
      done: input.done,
    },
  };

  return { message, bytes: jsonBytes(message) };
}

export function interruptMessage(conversationId: string): {
  message: {
    message_type: "conversation";
    event_type: "conversation.interrupt";
    conversation_id: string;
  };
  bytes: number;
} {
  const message = {
    message_type: "conversation" as const,
    event_type: "conversation.interrupt" as const,
    conversation_id: conversationId,
  };
  return { message, bytes: jsonBytes(message) };
}

/** True when the serialised envelope fits Daily's documented 4 KB cap. */
export function fitsDailyAppMessage(bytes: number): boolean {
  return bytes <= DAILY_APP_MESSAGE_LIMIT_BYTES;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
