import { generateObject } from "ai";
import { z } from "zod";

import { receptionistModel } from "@/agent/lib/models";
import type { BusinessProfile } from "@/server/receptionist/profile";
import { describeHours } from "@/server/receptionist/prompt";
import type { Interval } from "@/server/receptionist/slots";
import { describeLocal } from "@/server/receptionist/time";

/**
 * The website conversation. Not a FAQ bot: its job is a complete request —
 * what, where, how big, photos, who and how to reach them, and when — so the
 * owner can quote or book without calling back to ask.
 */

export type WidgetMessage = { role: "user" | "assistant"; content: string; at: string };

export const collectedSchema = z.object({
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  job: z.string().nullable().describe("One line: what needs doing."),
  when: z.string().nullable().describe("When it suits the customer, in their words or a chosen slot."),
});

export type Collected = z.infer<typeof collectedSchema>;

export const turnSchema = z.object({
  reply: z.string().describe("Your next message to the customer. Norwegian unless they write another language. At most three short sentences."),
  collected: collectedSchema.describe("Everything known so far, carried forward from earlier turns."),
  ready: z
    .boolean()
    .describe("True when the job is described well enough for a quote or a visit AND there is a name and a phone or email."),
  suggestions: z.array(z.string()).max(3).describe("Up to three short replies the customer might tap. Empty if none fit."),
});

export type Turn = z.infer<typeof turnSchema>;

export const EMPTY_COLLECTED: Collected = {
  name: null,
  phone: null,
  email: null,
  address: null,
  job: null,
  when: null,
};

export function buildWebInstructions(input: {
  profile: BusinessProfile;
  now: Date;
  slots: Interval[];
  photos: number;
  collected: Collected;
}): string {
  const { profile } = input;
  const name = profile.name || "bedriften";
  const tz = profile.timezone;

  const sections = [
    [
      `Du er assistenten på nettsiden til ${name}. Du er en AI, og sier det ærlig om noen spør.`,
      "Målet ditt er en komplett forespørsel som eieren kan gi tilbud på eller booke ut fra, uten å måtte ringe og spørre:",
      "1. Hva som skal gjøres, med detaljene en fagperson trenger (omfang, størrelse, materiale, hvor ille, hvor lenge).",
      "2. Hvor (adresse eller sted), hvis jobben skjer hos kunden.",
      "3. Bilder når det hjelper. Kunden kan legge ved bilder med binders-knappen i chatten; be om det konkret («ta gjerne et bilde av …»).",
      "4. Når det passer.",
      "5. Navn, og telefon eller e-post.",
      "Spør om én ting om gangen, og bare om det du ikke vet. Svar kort og varmt, som en dyktig fagperson.",
      "Når du har nok: oppsummer kort og be kunden trykke «Send forespørsel». Si at de får svar fra eieren, med tilbud eller forslag til tid.",
    ].join("\n"),
    ["## Om bedriften", profile.summary, profile.address && `Adresse: ${profile.address}`, profile.serviceArea && `Område: ${profile.serviceArea}`]
      .filter(Boolean)
      .join("\n"),
    `## Åpningstider (${tz})\n${describeHours(profile)}`,
  ];

  if (profile.services.length) {
    sections.push(
      "## Tjenester\n" +
        profile.services.map((service) => `- ${service.name}${service.price ? ` (${service.price})` : ""}${service.description ? `: ${service.description}` : ""}`).join("\n")
    );
  }
  if (profile.priceItems.length || profile.prices) {
    sections.push(
      [
        `## Priser (${profile.pricesIncludeVat ? "inkl." : "eks."} mva)`,
        ...profile.priceItems.map((item) => `- ${item.name}: ${item.price} kr per ${item.unit}`),
        profile.prices,
        "Du kan nevne disse prisene. Lov aldri en totalpris; si at eieren sender et tilbud.",
      ]
        .filter(Boolean)
        .join("\n")
    );
  } else {
    sections.push("## Priser\nIngen prisliste. Ikke nevn priser; si at eieren sender et tilbud.");
  }
  if (profile.faq.length) {
    sections.push("## Vanlige spørsmål\n" + profile.faq.map((entry) => `Sp: ${entry.q}\nSv: ${entry.a}`).join("\n"));
  }
  if (profile.bookingEnabled && input.slots.length) {
    sections.push(
      [
        "## Ledige tider",
        ...input.slots.map((slot) => `- ${describeLocal(slot.start, tz)}`),
        "Tilby gjerne to av disse når kunden vil ha besøk eller time. Si at eieren bekrefter; ikke si at det er booket.",
      ].join("\n")
    );
  }
  if (profile.instructions) sections.push(`## Eierens regler (følg disse)\n${profile.instructions}`);

  sections.push(
    [
      "## Status",
      `Nå: ${describeLocal(input.now, tz)}.`,
      `Bilder lagt ved så langt: ${input.photos}.`,
      `Innsamlet: ${JSON.stringify(input.collected)}`,
      "Akutt fare: be dem ringe 113, 110 eller 112. Be aldri om personnummer, kortnummer eller passord.",
    ].join("\n")
  );

  return sections.join("\n\n");
}

/** Pure: whether the request can be sent. The model's `ready` is advice. */
export function canSubmit(collected: Collected): boolean {
  const hasContact = Boolean(collected.phone?.trim() || collected.email?.trim());
  return Boolean(collected.job?.trim()) && Boolean(collected.name?.trim()) && hasContact;
}

export function formatTranscript(messages: WidgetMessage[], photos: number): string {
  const lines = messages.map((message) => `${message.role === "user" ? "Kunde" : "Assistent"}: ${message.content}`);
  if (photos > 0) lines.push(`[Kunden la ved ${photos} ${photos === 1 ? "bilde" : "bilder"}]`);
  return lines.join("\n");
}

export async function runTurn(input: {
  profile: BusinessProfile;
  messages: WidgetMessage[];
  collected: Collected;
  slots: Interval[];
  photos: number;
  now: Date;
}): Promise<Turn> {
  const { object } = await generateObject({
    model: receptionistModel(),
    schema: turnSchema,
    system: buildWebInstructions(input),
    messages: input.messages.slice(-30).map((message) => ({ role: message.role, content: message.content })),
  });
  return object;
}
