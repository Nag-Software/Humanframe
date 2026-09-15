import { logger } from "@/lib/logger";
import { getAgentRuntime } from "@/server/agent/runtime/eve-runtime";
import type { CallBinding } from "@/server/call/binding";
import { getThread, linkEveSession } from "@/server/db/repositories/threads";

/**
 * Backend work for a call, done by the same agent that answers in chat.
 *
 * This is the point of client delegation. The provider tells us the model
 * wants something done and nothing more — no task text, no tool name, no
 * arguments — so the work is decided here, from the conversation, by eve. That
 * means a call reaches every tool Maya has: web search, the user's mailbox,
 * her own memory, commitments. There is no second, smaller tool surface kept
 * in step with the real one, because there is no second tool surface.
 *
 * The call binding decides whose data this touches. Nothing in the transcript
 * can widen that: the transcript chooses *what* to ask, never *whose* account
 * to ask it of.
 */

/** A spoken answer has to arrive while the silence is still explainable. */
const DELEGATION_TIMEOUT_MS = 25_000;

/** `session.commentary.append` takes about 500 tokens. This stays under it. */
const MAX_SPOKEN_CHARACTERS = 1_200;

const CONTEXT_TURNS = 12;

export type DelegationTurn = {
  role: "user" | "assistant";
  text: string;
};

export type DelegationResult = {
  /** What Maya should say. The model paraphrases rather than reads it. */
  content: string;
  /** True when the answer came from the agent rather than a fallback. */
  answered: boolean;
};

const DIRECTIVE = `You are mid-conversation on a voice call. Do the work the
last thing said asks for, using your tools, and reply with the answer only.

Write it to be spoken: plain sentences, no markdown, no lists, no URLs. Keep it
under about sixty words. Do not greet, do not describe what you are about to do,
and do not ask whether you should proceed — you are already doing it.

If the request needs an approval you cannot get out loud, say so in one sentence
and say it can be finished in the chat.`;

/**
 * Runs one delegation to completion and returns what to say.
 *
 * The call's own thread carries the eve session, so a call continues the same
 * conversation the thread already had instead of starting a stranger each
 * time — and anything learned lands on the thread the user can read later.
 */
export async function runDelegation(input: {
  binding: CallBinding;
  transcript: DelegationTurn[];
  cookie: string | null;
  origin: string | null;
}): Promise<DelegationResult> {
  const { binding } = input;
  const runtime = getAgentRuntime({
    cookie: input.cookie,
    origin: input.origin,
  });

  const scope = {
    client: binding.client,
    workspaceId: binding.workspaceId,
    userId: binding.userId,
  };

  const thread = await getThread(scope, binding.threadId);
  const existing = thread?.eveSessionId ?? null;
  const message = [{ type: "text" as const, text: prompt(input.transcript) }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELEGATION_TIMEOUT_MS);

  try {
    let sessionId = existing;
    let fromIndex = 0;

    if (sessionId) {
      // Streaming from zero would replay the whole session; resume reports
      // where the history currently ends, and the reply lands after it.
      const resumed = await runtime.resumeRun({ sessionId });
      fromIndex = resumed.streamIndex;
      await runtime.continueSession({ sessionId, message, turnPolicy: "queue" });
    } else {
      const started = await runtime.startSession({
        workspaceId: binding.workspaceId,
        assistantId: binding.assistantId,
        threadId: binding.threadId,
        channel: "live",
        message,
      });
      sessionId = started.sessionId;
      await linkEveSession(scope, binding.threadId, sessionId);
    }

    let spoken = "";
    let needsApproval = false;

    for await (const event of runtime.streamRun({
      sessionId,
      fromIndex,
      signal: controller.signal,
    })) {
      if (event.type === "text.complete") {
        spoken = event.text;
        continue;
      }

      if (event.type === "approval.requested") {
        // Nobody can approve anything by voice, and a call must not be the
        // channel where that rule quietly stops applying.
        needsApproval = true;
        await runtime.cancelRun({ sessionId }).catch(() => undefined);
        break;
      }

      if (event.type === "run.status" && event.status !== "started") {
        if (event.status === "waiting") {
          continue;
        }
        break;
      }
    }

    if (needsApproval) {
      return {
        content:
          "That one needs your approval before I can do it, which we cannot " +
          "do out loud. I can finish it in the chat.",
        answered: false,
      };
    }

    const content = trim(spoken);
    if (!content) {
      return { content: "I could not get that just now.", answered: false };
    }

    return { content, answered: true };
  } catch (error) {
    logger.error("call.delegation_failed", {
      callSessionId: binding.callSessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    return { content: "I could not get that just now.", answered: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The conversation, as the agent sees it.
 *
 * Only the recent turns: a call can run long, and the request being delegated
 * is always near the end. The still-unfinished turn is included by the
 * assembler on the browser's side, because that is usually where the question
 * actually is.
 */
function prompt(transcript: DelegationTurn[]): string {
  const recent = transcript.slice(-CONTEXT_TURNS);
  const lines = recent.map(
    (turn) => `${turn.role === "user" ? "User" : "You"}: ${turn.text}`
  );

  return [DIRECTIVE, "", "## The conversation so far", ...lines].join("\n");
}

/** Spoken text has no room for a paragraph that trails off mid-word. */
function trim(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_SPOKEN_CHARACTERS) {
    return clean;
  }

  const cut = clean.slice(0, MAX_SPOKEN_CHARACTERS);
  const lastStop = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? ")
  );
  return lastStop > MAX_SPOKEN_CHARACTERS / 2
    ? cut.slice(0, lastStop + 1)
    : cut.trimEnd();
}
