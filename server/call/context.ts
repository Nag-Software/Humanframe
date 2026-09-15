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
- When you go and look something up, say what you are doing in a few words
  first, so the silence is explained.
- Before you promise a follow-up, say the day and time back in plain words and
  let the user confirm it.

## You have your tools here

This is the same you as in chat, on a different channel, and you can do the
same work: search the web, read the user's mail, look things up in your own
memory, make promises and keep them. Ask for the work and it gets done.

The one limit is approval. Anything that needs the user to agree before it
happens — sending a message as them, spending their money — cannot be approved
out loud. Say so in a sentence and offer to finish it in the chat.

## This is a conversation, not an interview

Do not wait to be asked. If something below is overdue, or you said you would
come back to something and have not, raise it yourself — early, and in one
sentence. If the user sounded worried about something last time you spoke, ask
how it went.

Then listen. One question at a time, and let it go if they would rather talk
about something else. The point is that you have your own thread of the
conversation, not that you run it.
`;

/** How many open promises are worth putting in front of her at once. */
const OPEN_COMMITMENTS = 5;

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

  const open = await openCommitments({
    client: input.client,
    workspaceId: input.workspaceId,
    assistantId: input.assistantId,
    userId: input.userId,
    now,
  });

  if (open.length > 0) {
    sections.push(
      "",
      "## Things you could raise yourself",
      ...open.map((row) => `- ${row.line}`)
    );
  }

  return {
    instructions: sections.join("\n"),
    memoryIds: context?.memoryIds ?? [],
  };
}

/**
 * The promises this user is still owed.
 *
 * Without these she can only react, and the call becomes an interview. They
 * are scoped to the user as well as the workspace: a promise made to a
 * colleague is not hers to bring up.
 */
async function openCommitments(input: {
  client: SupabaseClient;
  workspaceId: string;
  assistantId: string;
  userId: string;
  now: Date;
}): Promise<{ line: string }[]> {
  try {
    const { data } = await input.client
      .from("commitments")
      .select("title, due_at")
      .eq("workspace_id", input.workspaceId)
      .eq("assistant_id", input.assistantId)
      .eq("user_id", input.userId)
      .not("status", "in", '("done","cancelled")')
      .order("due_at", { ascending: true })
      .limit(OPEN_COMMITMENTS)
      .returns<{ title: string; due_at: string }[]>();

    return (data ?? []).map((row) => {
      const due = new Date(row.due_at);
      const overdue = due.getTime() < input.now.getTime();
      return {
        line: overdue
          ? `${row.title} — overdue since ${due.toISOString()}`
          : `${row.title} — due ${due.toISOString()}`,
      };
    });
  } catch {
    // An empty list is a quieter Maya, never a call that fails to connect.
    return [];
  }
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
