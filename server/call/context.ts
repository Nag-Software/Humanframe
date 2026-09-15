import { readFileSync } from "node:fs";
import path from "node:path";

import { buildContextPackage } from "@/agent/lib/context-package";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The instructions Maya speaks with.
 *
 * Identity, memory and tools are the same ones she uses in chat — the base
 * instruction file is read verbatim, and the context package is the same
 * builder the chat runtime injects each turn. Voice gets a short addendum, not
 * a personality of its own: the point of phase 5 is that it is the same
 * colleague on a different channel.
 *
 * History is deliberately absent. Realtime keeps the conversation it is having;
 * pouring a chat transcript in would cost tokens on every audio turn and make
 * her sound like she is reading notes.
 */
const VOICE_ADDENDUM = `
## You are speaking, not writing

- Answer out loud, in short sentences a person can follow by ear.
- No markdown, no lists, no headings, no code, no URLs read aloud.
- One idea per turn. Let the user interrupt you; stop talking when they do.
- When you use a tool, say what you are doing in a few words first, so the
  silence is explained.
- Before you promise a follow-up, say the day and time back in plain words and
  let the user confirm it.
- You cannot send email, edit documents or do anything risky while on a call.
  If the user asks for one of those, say so plainly and offer to carry on in
  the chat, where they can approve it.
`;

let baseInstructions: string | null = null;

function readBaseInstructions(): string {
  // Bundled by Next's server build; read once per process.
  baseInstructions ??= readFileSync(
    path.join(process.cwd(), "agent", "instructions.md"),
    "utf8"
  );
  return baseInstructions;
}

export type CallContextInput = {
  client: SupabaseClient;
  workspaceId: string;
  assistantId: string;
  userId: string;
  userName: string | null;
  timezone: string;
};

/**
 * Builds the full instruction text for one call.
 *
 * `now` and the timezone are stated explicitly because a spoken "Friday" has to
 * become an absolute instant before `schedule_followup` will accept it, and the
 * model has no clock of its own.
 */
export async function buildCallInstructions(
  input: CallContextInput
): Promise<{ instructions: string; memoryIds: string[] }> {
  const now = new Date();
  const scope = {
    client: input.client,
    workspaceId: input.workspaceId,
    assistantId: input.assistantId,
    userId: input.userId,
  };

  let context: { text: string; memoryIds: string[] } | null = null;
  try {
    context = await buildContextPackage(scope, { message: null });
  } catch {
    // Memory must never stop a call from connecting.
    context = null;
  }

  const sections = [
    readBaseInstructions(),
    VOICE_ADDENDUM,
    "## Right now",
    `- The user's name is ${input.userName ?? "unknown"}.`,
    `- Their timezone is ${input.timezone}.`,
    `- The current time is ${localTime(now, input.timezone)} (${now.toISOString()}).`,
    "- Resolve every spoken time against that timezone before you use it.",
  ];

  if (context) {
    sections.push("", context.text);
  }

  return {
    instructions: sections.join("\n"),
    memoryIds: context?.memoryIds ?? [],
  };
}

/** Human-readable local time, so the model does not have to do the arithmetic. */
export function localTime(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(at);
  } catch {
    return `${at.toISOString()} (UTC)`;
  }
}
