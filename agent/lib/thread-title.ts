import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText } from "ai";

import { memoryModel } from "./models";

/**
 * Maya names her own conversations.
 *
 * A thread starts life titled with the user's first message, which is what
 * the sidebar and the log would otherwise show forever. After the first
 * exchange she writes a real title — a few words, the way a person labels a
 * note — and the raw message is never shown again. Her title is never
 * overwritten by a later one: `title_source` records who named it.
 */
export const TITLE_MAX_LENGTH = 60;

export type TitleGenerator = (input: {
  userText: string | null;
  assistantText: string;
}) => Promise<string>;

/** Strips what models add and what a title must not carry. */
export function chooseTitle(raw: string): string | null {
  const cleaned = raw
    .replace(/^\s*(title|tittel)\s*:\s*/i, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/[.。!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < 2) {
    return null;
  }
  return cleaned.length > TITLE_MAX_LENGTH
    ? `${cleaned.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : cleaned;
}

export const generateThreadTitle: TitleGenerator = async (input) => {
  const { text } = await generateText({
    model: memoryModel(),
    temperature: 0.2,
    system: [
      "You name a conversation between a user and their colleague Maya.",
      "Reply with the title only: two to six words, in the language of the",
      "conversation, no quotes, no trailing punctuation, no 'Conversation",
      "about'. Name the subject, not the act of talking about it.",
    ].join(" "),
    prompt: [
      input.userText ? `User: ${input.userText.slice(0, 1200)}` : null,
      `Maya: ${input.assistantText.slice(0, 1200)}`,
    ]
      .filter((line) => line !== null)
      .join("\n\n"),
  });
  return text;
};

/**
 * Titles a thread once, if nobody has yet. Returns the title it set, or null
 * when the thread already had one of hers or nothing usable came back.
 */
export async function titleThreadIfNeeded(
  client: SupabaseClient,
  input: {
    threadId: string;
    userText: string | null;
    assistantText: string;
    generate?: TitleGenerator;
  }
): Promise<string | null> {
  const { data: thread } = await client
    .from("threads")
    .select("id, title_source")
    .eq("id", input.threadId)
    .maybeSingle<{ id: string; title_source: "user" | "assistant" }>();

  if (!thread || thread.title_source === "assistant") {
    return null;
  }
  if (input.assistantText.trim().length === 0) {
    return null;
  }

  const generate = input.generate ?? generateThreadTitle;
  const title = chooseTitle(await generate(input));
  if (!title) {
    return null;
  }

  // Only the first namer wins: a concurrent run lands on `title_source`
  // already being hers and changes nothing.
  const { data: updated } = await client
    .from("threads")
    .update({ title, title_source: "assistant" })
    .eq("id", input.threadId)
    .eq("title_source", "user")
    .select("id")
    .maybeSingle<{ id: string }>();

  return updated ? title : null;
}
