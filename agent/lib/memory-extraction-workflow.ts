import { learnFromExchange } from "./memory-extraction";
import { resolveMemoryScope } from "./session-scope";

/**
 * Memory extraction's own durable run.
 *
 * Detached with `start()`, the same way notifications are. eve awaits every
 * hook before it emits `session.waiting`, and extraction is a model call, so
 * running it inside `turn.completed` left the composer on "working" for
 * several seconds after the reply was already on screen.
 *
 * The workflow's identity is this module path plus the function name, so
 * neither may be renamed while runs are in flight.
 */
export type ExtractTurnMemoryInput = {
  sessionId: string;
  userId: string;
  userText: string;
  assistantText: string;
  eventId: string | null;
  occurredAt: string;
};

export async function extractTurnMemory(
  input: ExtractTurnMemoryInput
): Promise<void> {
  "use workflow";
  await extractTurnMemoryStep(input);
}

async function extractTurnMemoryStep(
  input: ExtractTurnMemoryInput
): Promise<void> {
  "use step";
  await runExtractTurnMemory(input);
}

export async function runExtractTurnMemory(
  input: ExtractTurnMemoryInput
): Promise<void> {
  try {
    const scope = await resolveMemoryScope({
      id: input.sessionId,
      auth: {
        initiator: {
          principalId: input.userId,
          authenticator: "supabase",
        },
      },
    });
    if (!scope) {
      return;
    }

    const { data: thread } = await scope.client
      .from("threads")
      .select("id")
      .eq("eve_session_id", input.sessionId)
      .maybeSingle<{ id: string }>();

    // persist-turn stores eve's event id on the message row, so the event id
    // the hook carries resolves to the message a memory came from.
    const { data: message } = input.eventId
      ? await scope.client
          .from("messages")
          .select("id")
          .eq("thread_id", thread?.id ?? "")
          .eq("source_message_id", input.eventId)
          .maybeSingle<{ id: string }>()
      : { data: null };

    const result = await learnFromExchange({
      userText: input.userText,
      assistantText: input.assistantText,
      scope,
      source: {
        threadId: thread?.id ?? null,
        messageId: message?.id ?? null,
        occurredAt: input.occurredAt,
      },
    });

    if (result) {
      console.log(
        JSON.stringify({
          level: "info",
          event: "memory.extracted",
          sessionId: input.sessionId,
          ...result,
        })
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "memory.extraction_failed",
        sessionId: input.sessionId,
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
}
