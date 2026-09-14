import { webSearchTool } from "@/lib/maya/model";
import {
  tool,
  type InferUITool,
  type UIDataTypes,
  type UIMessage,
} from "ai";
import { z } from "zod";

/**
 * Lager en nedlastbar fil som rendres som et kompakt filkort i chatten.
 */
export const createFile = tool({
  description:
    "Lag en nedlastbar fil for brukeren (notat, tabell, kode, JSON e.l.). " +
    "Bruk denne når svaret er et dokument brukeren vil beholde, ikke bare lese.",
  inputSchema: z.object({
    filename: z.string().describe("Filnavn med endelse, f.eks. 'tilbud.md'"),
    mediaType: z
      .string()
      .describe("IANA media type, f.eks. 'text/markdown' eller 'text/csv'"),
    content: z.string().describe("Hele innholdet i filen"),
  }),
  execute: async ({ filename, mediaType, content }) => {
    const bytes = new TextEncoder().encode(content);
    return {
      filename,
      mediaType,
      size: bytes.byteLength,
      url: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  },
});

/**
 * Lenkekort med favicon, tittel, domene og beskrivelse.
 */
export const showWebsite = tool({
  description:
    "Vis et nettsted som et lenkekort med tittel, domene og beskrivelse. " +
    "Bruk når du peker brukeren mot én konkret side.",
  inputSchema: z.object({
    url: z.string().describe("Full URL inkludert https://"),
    title: z.string(),
    description: z.string().describe("Én til to setninger om siden"),
    preview: z
      .boolean()
      .optional()
      .describe(
        "Sett true for å vise siden i en innebygd forhåndsvisning (iframe)"
      ),
  }),
  execute: async (input) => input,
});

/**
 * Henter innholdet på en URL. Krever godkjenning fra brukeren – derfor
 * rendres den som et bekreftelseskort før den kjører.
 */
export const fetchUrl = tool({
  description:
    "Hent tekstinnholdet fra en URL slik at du kan lese og oppsummere det. " +
    "Krever godkjenning fra brukeren.",
  inputSchema: z.object({
    url: z.string().describe("Full URL inkludert https://"),
    reason: z.string().describe("Kort begrunnelse for hvorfor du vil hente den"),
  }),
  needsApproval: true,
  execute: async ({ url }) => {
    const response = await fetch(url, {
      headers: { "user-agent": "HumanframeMaya/1.0" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fra ${url}`);
    }
    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { url, excerpt: text.slice(0, 8000) };
  },
});

/** Strukturert e-postutkast som rendres som et utkastkort. */
export const draftEmail = tool({
  description:
    "Lever et e-postutkast strukturert, slik at brukeren kan lese og kopiere det.",
  inputSchema: z.object({
    to: z.array(z.string()).describe("Mottakere"),
    subject: z.string(),
    body: z.string().describe("Brødtekst i markdown"),
  }),
  execute: async (input) => input,
});

/** Forhåndsvisning av en kalenderhendelse. Maya oppretter ingenting selv. */
export const previewCalendarEvent = tool({
  description:
    "Vis et forslag til kalenderhendelse. Oppretter ikke hendelsen – bare forslaget.",
  inputSchema: z.object({
    title: z.string(),
    start: z.string().describe("ISO 8601 starttid"),
    end: z.string().describe("ISO 8601 sluttid"),
    location: z.string().optional(),
    attendees: z.array(z.string()).optional(),
    notes: z.string().optional(),
  }),
  execute: async (input) => input,
});

export const mayaTools = {
  createFile,
  showWebsite,
  fetchUrl,
  draftEmail,
  previewCalendarEvent,
  webSearch: webSearchTool(),
};

export type MayaTools = {
  createFile: InferUITool<typeof createFile>;
  showWebsite: InferUITool<typeof showWebsite>;
  fetchUrl: InferUITool<typeof fetchUrl>;
  draftEmail: InferUITool<typeof draftEmail>;
  previewCalendarEvent: InferUITool<typeof previewCalendarEvent>;
  webSearch: InferUITool<(typeof mayaTools)["webSearch"]>;
};

export type MayaMessage = UIMessage<MayaMetadata, UIDataTypes, MayaTools>;

export type MayaMetadata = {
  createdAt?: string;
  model?: string;
};
