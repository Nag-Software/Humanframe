import { signalMarker } from "../../lib/signals";

/**
 * The trace a call leaves in the conversation.
 *
 * Every spoken turn is already persisted, but the thread's own history — the
 * eve session the user reads — never saw the call. When it ends, Humanframe
 * tells Maya, and her answer becomes the chapter: what was said, what was
 * decided, what she is now holding. Written by her, in her voice, so a call
 * is part of the relationship's history rather than a gap in it.
 */

/** Calls shorter than this, or with fewer turns, leave no trace. */
export const TRACE_MIN_DURATION_MS = 15_000;
export const TRACE_MIN_TURNS = 2;

export function callDeservesTrace(input: {
  durationMs: number;
  turnCount: number;
}): boolean {
  return (
    input.durationMs >= TRACE_MIN_DURATION_MS &&
    input.turnCount >= TRACE_MIN_TURNS
  );
}

export function buildCallEndedMessage(input: {
  callSessionId: string;
  durationMs: number;
  turnCount: number;
  video: boolean;
}): string {
  const minutes = Math.max(1, Math.round(input.durationMs / 60_000));
  return [
    signalMarker("call-ended", input.callSessionId),
    `The ${input.video ? "video call" : "call"} with the user just ended. It`,
    `lasted about ${minutes} minute${minutes === 1 ? "" : "s"} (${input.turnCount} turns).`,
    "",
    "Write its trace for the conversation, in one to three sentences, first",
    "person, past tense: what you went through, what was decided, and what",
    "you are now holding — with dates where there are any. No greeting and no",
    "sign-off. If nothing of substance was said, one short sentence that the",
    "call ended is enough.",
  ].join("\n");
}
