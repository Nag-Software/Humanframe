import { signalMarker } from "../../lib/signals";

/**
 * Opening the day.
 *
 * When a returning user arrives and their last conversation has gone quiet,
 * Maya speaks first — but only when she has something: a promise that is due
 * or overdue, or threads from the last few days worth picking up. The
 * decision is made from data, here, not left to the model, so an empty
 * morning stays quiet instead of producing a greeting for its own sake.
 */
export type OpeningCommitment = {
  title: string;
  kind: "follow_up" | "remind" | "deliver";
  dueAt: string;
  status: string;
};

export type OpeningThread = {
  title: string | null;
  lastMessageAt: string;
};

export type OpeningBrief = {
  commitments: OpeningCommitment[];
  recentThreads: OpeningThread[];
  /** IANA zone, when the user has set one. */
  timezone: string | null;
};

/** Threads and commitments older than this are not "recent". */
export const OPENING_LOOKBACK_DAYS = 7;
/** Commitments due further out than this are not mentioned. */
export const OPENING_LOOKAHEAD_DAYS = 7;

export function hasSomethingToOpen(brief: OpeningBrief): boolean {
  return brief.commitments.length > 0 || brief.recentThreads.length > 0;
}

/** One marker per day: a retry on the same day is the same opening. */
export function openingMarker(now: Date, timezone: string | null): string {
  return signalMarker("open-day", localDate(now, timezone));
}

export function buildOpeningMessage(brief: OpeningBrief, now: Date): string {
  const zone = brief.timezone ?? "UTC";
  const today = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: zone,
  }).format(now);

  const commitments = brief.commitments.map((commitment) => {
    const due = new Date(commitment.dueAt);
    const overdue = due.getTime() < now.getTime();
    const when = new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: zone,
    }).format(due);
    return `- ${overdue ? "OVERDUE" : "Due"} ${when}: ${commitment.title} (${commitment.kind.replace("_", "-")})`;
  });

  const threads = brief.recentThreads
    .filter((thread) => thread.title)
    .map((thread) => {
      const when = new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: zone,
      }).format(new Date(thread.lastMessageAt));
      return `- ${when}: ${thread.title}`;
    });

  return [
    openingMarker(now, brief.timezone),
    `A new day: ${today} (${zone}). The user has just opened Humanframe and`,
    "has not written anything. You are opening the conversation.",
    "",
    "Say what matters in two to four sentences: the most urgent open thing",
    "first, then what else is waiting, then at most one question. Use the",
    "language you last used with them. No greeting filler, no 'how can I",
    "help', and their name at most once. An overdue promise is said plainly.",
    "",
    commitments.length > 0 ? "## Open promises" : null,
    ...commitments,
    commitments.length > 0 ? "" : null,
    threads.length > 0 ? "## Recent conversations" : null,
    ...threads,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function localDate(now: Date, timezone: string | null): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone ?? "UTC",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
