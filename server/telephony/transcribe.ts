import { logger } from "@/lib/logger";

import { parseWav, rmsLevel, splitChannels } from "./wav";

/**
 * A call recording, turned into a dialogue.
 *
 * Each channel is transcribed on its own, with segment timestamps, and the
 * segments are interleaved by time. Whisper is used rather than a newer
 * transcription model because it returns segments with timestamps and a
 * no-speech probability — the two things that make interleaving and
 * hallucination filtering possible.
 */

export type Role = "caller" | "assistant";

export type Segment = { role: Role; start: number; end: number; text: string };

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const SILENCE_RMS = 0.002;
const NO_SPEECH_THRESHOLD = 0.6;

// Whisper's well-known hallucinations on near-silence, in Norwegian and English.
const HALLUCINATIONS = [
  /^teksting av/i,
  /^takk for at du (så|lyttet)/i,
  /^undertekster/i,
  /^thanks? for watching/i,
  /^subtitles by/i,
  /^\.+$/,
];

type WhisperSegment = { start: number; end: number; text: string; no_speech_prob?: number };

async function transcribeOne(input: {
  apiKey: string;
  wav: Buffer;
  language: string;
  prompt?: string;
}): Promise<WhisperSegment[]> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(input.wav)], { type: "audio/wav" }), "call.wav");
  form.append("model", process.env.TRANSCRIPTION_MODEL || "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("language", input.language);
  if (input.prompt) form.append("prompt", input.prompt.slice(0, 800));

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    logger.error("transcribe.failed", { status: response.status });
    throw new Error(`Transcription failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { segments?: WhisperSegment[]; text?: string };
  if (body.segments) return body.segments;
  return body.text ? [{ start: 0, end: 0, text: body.text }] : [];
}

export function cleanSegments(role: Role, segments: WhisperSegment[]): Segment[] {
  return segments
    .filter((segment) => (segment.no_speech_prob ?? 0) < NO_SPEECH_THRESHOLD)
    .map((segment) => ({
      role,
      start: segment.start,
      end: segment.end,
      text: segment.text.trim(),
    }))
    .filter((segment) => segment.text && !HALLUCINATIONS.some((pattern) => pattern.test(segment.text)));
}

/** Interleaves both sides by time and merges a speaker's consecutive lines. */
export function mergeDialogue(segments: Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Segment[] = [];
  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.role === segment.role) {
      last.text = `${last.text} ${segment.text}`;
      last.end = Math.max(last.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

export function formatDialogue(segments: Segment[]): string {
  return segments
    .map((segment) => `${segment.role === "caller" ? "Innringer" : "Resepsjonist"}: ${segment.text}`)
    .join("\n");
}

/**
 * Transcribes a recording. Two channels: caller on the first, the AI on the
 * second. One channel: a voicemail, all caller.
 */
export async function transcribeRecording(input: {
  apiKey: string;
  wav: Buffer;
  /** Names and words the transcriber should spell right: the business, its services. */
  vocabulary?: string;
  language?: string;
}): Promise<{ dialogue: Segment[]; text: string }> {
  const info = parseWav(input.wav);
  const language = input.language ?? "no";
  const channels = info.channels >= 2 ? splitChannels(info).slice(0, 2) : splitChannels(info);
  const roles: Role[] = channels.length >= 2 ? ["caller", "assistant"] : ["caller"];

  const perChannel = await Promise.all(
    channels.map(async (wav, index) => {
      // A silent channel makes Whisper invent text. Skip it outright.
      if (rmsLevel(wav) < SILENCE_RMS) return [];
      const segments = await transcribeOne({
        apiKey: input.apiKey,
        wav,
        language,
        prompt: input.vocabulary,
      });
      return cleanSegments(roles[index], segments);
    })
  );

  const dialogue = mergeDialogue(perChannel.flat());
  return { dialogue, text: formatDialogue(dialogue) };
}
