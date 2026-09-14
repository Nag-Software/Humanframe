import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
} from "ai";

import { mayaTools, type MayaMessage } from "@/lib/maya/tools";
import { mayaModel } from "@/lib/maya/model";
import { ensureConversation, saveMessages } from "@/lib/maya/store";

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

export async function POST(req: Request) {
  const body = (await req.json()) as {
    messages: MayaMessage[];
    conversationId?: string;
  };
  const { messages } = body;
  const conversationId = body.conversationId;

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
        console.error("[maya] stream error", error);
        return "Noe gikk galt under genereringen. Prøv igjen.";
      },
      onEnd: async ({ messages: finalMessages }) => {
        if (!conversationId) {
          return;
        }
        const firstUserText = finalMessages
          .find((message) => message.role === "user")
          ?.parts.find((part) => part.type === "text")?.text;

        await ensureConversation(conversationId, firstUserText);
        // Hele parts-strukturen lagres – tekst, filer, kilder, verktøykall
        // og godkjenningstilstand beholdes som de er.
        await saveMessages(conversationId, finalMessages);
      },
    }),
  });
}
