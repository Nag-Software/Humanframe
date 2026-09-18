/**
 * Signals: Humanframe talking to Maya.
 *
 * Some turns are not started by the user. A promise falls due, a new day
 * starts, a call ends — and Humanframe tells Maya in a message that begins
 * with a marker: `[humanframe:<kind>:<id>]`. The marker is what lets every
 * layer agree on what the message is:
 *
 *  - `persist-turn` files it on the system channel, never as something the
 *    user said;
 *  - the thread hides it, so the user sees only her answer;
 *  - a retry can find its own marker and refuse to send twice;
 *  - memory extraction skips it, because a directive is not a fact about
 *    the user.
 *
 * This module is shared by the UI and the agent, so it stays pure.
 */
export type SignalKind = "delivery" | "open-day" | "call-ended";

export const SIGNAL_PREFIX = "[humanframe:";

const PATTERN = /^\s*\[humanframe:([a-z-]+):([^\]\s]+)\]/;

export function signalMarker(kind: SignalKind, id: string): string {
  return `${SIGNAL_PREFIX}${kind}:${id}]`;
}

export function isSignal(text: string | null | undefined): boolean {
  return typeof text === "string" && PATTERN.test(text);
}

export function parseSignal(
  text: string
): { kind: SignalKind | string; id: string } | null {
  const match = PATTERN.exec(text);
  if (!match) {
    return null;
  }
  return { kind: match[1]!, id: match[2]! };
}

/** The first text of a message's content, whatever shape the runtime gives it. */
export function firstText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: string }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      return (part as { text: string }).text;
    }
  }
  return null;
}
