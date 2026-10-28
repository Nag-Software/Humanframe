import type { BusinessProfile } from "./profile";
import type { Interval } from "./slots";
import { describeLocal, WEEKDAYS } from "./time";

/**
 * What the AI on the phone is told, built fresh for every call.
 *
 * Pure: everything it needs is passed in, so the exact words a caller's
 * conversation rests on can be read in a test.
 */

const DAY_NAMES: Record<(typeof WEEKDAYS)[number], string> = {
  mon: "mandag",
  tue: "tirsdag",
  wed: "onsdag",
  thu: "torsdag",
  fri: "fredag",
  sat: "lørdag",
  sun: "søndag",
};

export function describeHours(profile: BusinessProfile): string {
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  const lines = order.map((day) => {
    const ranges = profile.openingHours[day] ?? [];
    return `${DAY_NAMES[day]}: ${ranges.length ? ranges.map(([a, b]) => `${a}–${b}`).join(", ") : "stengt"}`;
  });
  return lines.join("\n");
}

export type PromptInput = {
  profile: BusinessProfile;
  now: Date;
  callerPhone: string | null;
  history: { callerName: string | null; title: string; summary: string; startedAt: string }[];
  slots: Interval[];
  /** False when the calendar could not be read: offer no times then. */
  slotsKnown: boolean;
};

export function buildReceptionistInstructions(input: PromptInput): string {
  const { profile } = input;
  const name = profile.name || "bedriften";
  const tz = profile.timezone;

  const sections: string[] = [];

  sections.push(
    [
      `Du er resepsjonisten til ${name}, og svarer telefonen når de ikke selv kan ta den.`,
      "Du er en AI. Si det ærlig hvis noen spør, og lat aldri som du er et menneske.",
      "Innringeren har nettopp hørt en kort hilsen som sa at samtalen tas opp. Ikke gjenta hilsenen; svar på det de sier.",
      "Snakk norsk, kort og vennlig, som en dyktig resepsjonist i en liten bedrift. Bytt språk bare hvis innringeren gjør det.",
      "Du kan ikke sette over samtalen, sende noe eller bekrefte noe på egen hånd mens samtalen pågår.",
    ].join("\n")
  );

  sections.push(
    [
      "## Målet med samtalen",
      "Finn ut hva innringeren trenger, slik at eieren kan følge opp uten å ringe tilbake for å spørre:",
      "1. Navn.",
      "2. Hva det gjelder, med de detaljene en fagperson trenger (hva, hvor stort, hvor haster det).",
      "3. Adresse eller sted, hvis jobben skjer hos kunden.",
      "4. Når det passer, hvis de vil ha en time eller et besøk.",
      "5. Om nummeret de ringer fra er riktig å nå dem på.",
      "Spør om én ting om gangen, og bare om det du ikke allerede vet.",
      "Når det hjelper, tilby å sende en SMS med en lenke der de kan laste opp bilder (for eksempel av en skade) eller lese mer.",
      "Avslutt med å oppsummere kort og si hva som skjer videre: eieren får beskjed med en gang og bekrefter på SMS.",
    ].join("\n")
  );

  const about = [
    "## Om bedriften",
    profile.summary || null,
    profile.address ? `Adresse: ${profile.address}` : null,
    profile.serviceArea ? `Område: ${profile.serviceArea}` : null,
    profile.contactPhone ? `Telefon: ${profile.contactPhone}` : null,
    profile.contactEmail ? `E-post: ${profile.contactEmail}` : null,
    profile.websiteUrl ? `Nettside: ${profile.websiteUrl}` : null,
  ].filter(Boolean);
  sections.push(about.join("\n"));

  sections.push(`## Åpningstider (${tz})\n${describeHours(profile)}`);

  if (profile.services.length > 0) {
    sections.push(
      "## Tjenester\n" +
        profile.services
          .map((service) =>
            [`- ${service.name}`, service.description, service.price ? `Pris: ${service.price}` : ""]
              .filter(Boolean)
              .join(". ")
          )
          .join("\n")
    );
  }

  sections.push(
    [
      "## Priser",
      profile.prices || "Ingen prisliste er oppgitt.",
      "Si bare priser som står her. Spør innringeren om detaljer og si at eieren gir et presist tilbud, i stedet for å gjette.",
    ].join("\n")
  );

  if (profile.faq.length > 0) {
    sections.push(
      "## Vanlige spørsmål\n" + profile.faq.map((entry) => `Sp: ${entry.q}\nSv: ${entry.a}`).join("\n")
    );
  }

  if (profile.bookingEnabled) {
    if (input.slotsKnown && input.slots.length > 0) {
      sections.push(
        [
          "## Ledige tider",
          ...input.slots.map((slot) => `- ${describeLocal(slot.start, tz)}`),
          `En vanlig avtale tar ${profile.appointmentMinutes} minutter.`,
          "Tilby to av disse når noen vil ha en time. Si at du noterer ønsket, og at eieren bekrefter tiden på SMS. Ikke si at timen er booket.",
        ].join("\n")
      );
    } else {
      sections.push(
        "## Timer\nDu kan ikke se kalenderen nå. Spør hvilke dager og tidspunkt som passer, og si at eieren kommer tilbake med en tid på SMS."
      );
    }
  }

  if (input.history.length > 0) {
    const latest = input.history[0];
    sections.push(
      [
        "## Denne innringeren har vært i kontakt før",
        latest.callerName ? `Navn: ${latest.callerName}` : null,
        ...input.history
          .slice(0, 3)
          .map(
            (entry) =>
              `- ${describeLocal(new Date(entry.startedAt), tz)}: ${entry.title}${entry.summary ? ` – ${entry.summary}` : ""}`
          ),
        "Hils gjerne kjent og vis at du husker, men bekreft navnet før du bruker det. Ikke les opp detaljer fra tidligere saker uoppfordret.",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  if (profile.instructions) {
    sections.push(`## Eierens egne regler (følg disse)\n${profile.instructions}`);
  }

  sections.push(
    [
      "## Grenser",
      "- Akutt fare for liv eller helse: be dem ringe 113 (medisinsk), 110 (brann) eller 112 (politi) med en gang.",
      "- Ikke lov noe på eierens vegne: ikke pris, ikke tid, ikke at noen kommer.",
      "- Ikke be om personnummer, kortnummer eller passord.",
      "- Er det selgere eller reklame: avslutt høflig.",
      `- Nå er det ${describeLocal(input.now, tz)}.`,
      input.callerPhone ? `- Innringeren ringer fra ${input.callerPhone}.` : "- Nummeret til innringeren er skjult; spør om et nummer eieren kan nå dem på.",
    ].join("\n")
  );

  return sections.join("\n\n");
}

/**
 * What Twilio says before the AI joins: immediate pickup, plus the notice
 * that the call is recorded and answered by an AI.
 */
export function buildGreeting(profile: BusinessProfile): string {
  if (profile.greeting.trim()) return profile.greeting.trim();
  const name = profile.name || "oss";
  return `Hei, du har kommet til ${name}. Du snakker med en digital assistent, og samtalen tas opp slik at vi kan følge deg opp.`;
}

/** What Twilio says when the AI cannot be reached: take a message instead. */
export function buildVoicemailPrompt(profile: BusinessProfile): string {
  const name = profile.name || "oss";
  return `Hei, du har kommet til ${name}. Vi kan ikke ta telefonen akkurat nå. Legg igjen navn, hva det gjelder og når det passer å bli ringt opp, etter pipetonen. Samtalen tas opp.`;
}
