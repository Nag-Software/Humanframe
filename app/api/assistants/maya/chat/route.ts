import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
} from "ai";
import { z } from "zod";

import { errorFields, logger } from "@/lib/logger";
import { mayaModel } from "@/lib/maya/model";
import { mayaTools, type MayaMessage } from "@/lib/maya/tools";
import { getAssistantBySlug } from "@/server/db/repositories/assistants";
import {
  getSourceTimestamps,
  writeMessages,
  type MessageWrite,
} from "@/server/db/repositories/messages";
import { ensureThread, touchThread } from "@/server/db/repositories/threads";
import { getRequestScope } from "@/server/db/request-scope";

export const maxDuration = 60;

const SYSTEM_PROMPT = `Du er Maya – en varm, presis og effektiv AI-assistent for Humanframe.

Stil:
- Svar på samme språk som brukeren skriver på (som regel norsk).
- Vær konkret og kortfattet. Ingen fyllord, ingen unødvendige forbehold.
- Bruk markdown: overskrifter, lister, tabeller og kodeblokker der det gjør svaret lettere å lese.

Verktøy:
- webSearch: bruk når spørsmålet handler om ferske hendelser, priser, dokumentasjon eller noe du ikke kan vite sikkert. Oppgi kildene.
- showWebsite: bruk når du peker brukeren mot én konkret nettside.
- createFile: bruk når svaret er et dokument brukeren vil beholde (notat, CSV, JSON, kode).
- draftEmail: bruk når brukeren ber om en e-post. Lever utkastet via verktøyet, ikke som ren tekst.
- previewCalendarEvent: bruk når du foreslår et møte eller en avtale.
- fetchUrl: bruk når du må lese en konkret URL. Den krever godkjenning fra brukeren.

Du kan motta bilder og dokumenter fra brukeren – les dem før du svarer.`;

const bodySchema = z.object({
  messages: z.array(z.unknown()),
  threadId: z.uuid(),
});

export async function POST(req: Request) {
  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const messages = parsed.data.messages as MayaMessage[];
  const threadId = parsed.data.threadId;

  const assistant = await getAssistantBySlug(
    scope.client,
    scope.workspaceId,
    "maya"
  );
  if (!assistant) {
    return Response.json({ error: "Assistant not found" }, { status: 404 });
  }

  // Claim the thread before streaming: this establishes ownership and lets row
  // level security reject a thread from another workspace before any model
  // tokens are spent.
  const firstUserText = messages
    .find((message) => message.role === "user")
    ?.parts.find((part) => part.type === "text")?.text;

  try {
    await ensureThread(scope, {
      threadId,
      assistantId: assistant.id,
      title: firstUserText,
      channel: "chat",
    });
  } catch (error) {
    logger.warn("maya.thread_claim_failed", {
      threadId,
      workspaceId: scope.workspaceId,
      ...errorFields(error),
    });
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = streamText({
    model: mayaModel(),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools: mayaTools,
    stopWhen: stepCountIs(6),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      tools: mayaTools,
      sendSources: true,
      sendReasoning: true,
      originalMessages: messages,
      onError: (error) => {
        logger.error("maya.stream_error", {
          workspaceId: scope.workspaceId,
          ...errorFields(error),
        });
        return "Noe gikk galt under genereringen. Prøv igjen.";
      },
      onEnd: async ({ messages: finalMessages }) => {
        // The whole parts structure is stored — text, files, sources, tool
        // calls and approval state are kept as they are.
        //
        // The AI SDK resends the full transcript every turn without stable
        // per-message timestamps, so known messages keep the timestamp they
        // already have and only new ones get a fresh, monotonic one. That
        // keeps the (thread_id, source_message_id, created_at) upsert
        // idempotent. eve hooks will carry their own event timestamps.
        const known = await getSourceTimestamps(scope, threadId);
        let nextMillis = Date.now();

        const writes: MessageWrite[] = finalMessages.map((message) => {
          const existing = known.get(message.id);
          const createdAt = existing ?? new Date(nextMillis++).toISOString();
          return {
            threadId,
            assistantId: assistant.id,
            channel: "chat" as const,
            role: message.role,
            content: message.parts,
            metadata: message.metadata,
            sourceMessageId: message.id,
            createdAt,
          };
        });

        try {
          await writeMessages(scope, writes);
          const lastCreatedAt = writes.at(-1)?.createdAt;
          if (lastCreatedAt) {
            await touchThread(scope, threadId, lastCreatedAt);
          }
        } catch (error) {
          logger.error("maya.persist_turn_failed", {
            threadId,
            ...errorFields(error),
          });
        }
      },
    }),
  });
}
