import { generateObject } from "ai";
import { z } from "zod";

import { receptionistModel } from "@/agent/lib/models";

import { normalizePhone, type BusinessProfile } from "./profile";
import type { Interval } from "./slots";
import { describeLocal } from "./time";

/**
 * From a finished call to a short list of things the owner can approve.
 *
 * Two halves. `extractIntake` asks a model to read the transcript into a
 * fixed shape. `proposeActions` is pure: it turns that shape into proposals
 * with plain rules, so what the owner is asked to approve is decided by code
 * that can be read and tested, not by the model.
 */

export const intakeSchema = z.object({
  callerName: z.string().nullable().describe("The caller's name if they said it, else null."),
  callerEmail: z.string().nullable(),
  callbackNumber: z
    .string()
    .nullable()
    .describe("A number the caller asked to be reached on, only if different from the one they called from."),
  title: z.string().describe("At most 8 words, Norwegian: what this is about. E.g. 'Lekkasje under kjøkkenvask'."),
  summary: z
    .string()
    .describe("2–4 sentences in Norwegian for the owner: what the caller needs, key details, what was promised."),
  category: z.enum(["booking", "quote", "question", "emergency", "existing_customer", "spam", "other"]),
  urgency: z.enum(["low", "normal", "high"]),
  address: z.string().nullable(),
  wantsAppointment: z.boolean(),
  agreedSlot: z
    .string()
    .nullable()
    .describe("If the caller accepted one of the offered times: that time as ISO 8601 with offset. Else null."),
  preferredTimes: z
    .array(z.string())
    .max(5)
    .describe("What the caller said about when it suits them, in their words."),
  wantsPhotoLink: z.boolean().describe("True if photos would help, or the caller agreed to receive an upload link."),
  wantsInfoLink: z.boolean().describe("True if the caller asked for more information or a link to read more."),
  openQuestions: z.array(z.string()).max(5).describe("Questions only the owner can answer."),
  suggestedReply: z
    .string()
    .describe(
      "A short SMS the owner could send the caller (Norwegian, friendly, max 300 characters): an answer, a follow-up question or a quote draft. Never invent prices. Empty if a booking confirmation covers it."
    ),
});

export type Intake = z.infer<typeof intakeSchema>;

export async function extractIntake(input: {
  transcript: string;
  profile: BusinessProfile;
  offeredSlots: Interval[];
  now: Date;
  channel: "phone" | "voicemail" | "sms";
}): Promise<Intake> {
  const tz = input.profile.timezone;
  const offered = input.offeredSlots.map((slot) => `- ${slot.start.toISOString()} (${describeLocal(slot.start, tz)})`);

  const { object } = await generateObject({
    model: receptionistModel(),
    schema: intakeSchema,
    system: [
      `You read a ${input.channel === "sms" ? "text message conversation" : input.channel === "voicemail" ? "voicemail" : "phone call"} between a caller and the AI receptionist of a small Norwegian business, and fill in the intake the owner will act on.`,
      "Use only what was said. Do not invent names, addresses, times or prices.",
      `The business: ${input.profile.name || "unknown"}. ${input.profile.summary}`,
      `It is now ${input.now.toISOString()} (${describeLocal(input.now, tz)}, timezone ${tz}).`,
      offered.length ? `Times the receptionist could offer:\n${offered.join("\n")}` : "No times were offered.",
    ].join("\n"),
    prompt: input.transcript,
  });
  return object;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export const bookingPayloadSchema = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  title: z.string().trim().min(1).max(200),
  customerName: z.string().trim().max(120).default(""),
  customerPhone: z.string().trim().max(20).nullable().default(null),
  address: z.string().trim().max(300).default(""),
  notes: z.string().trim().max(2000).default(""),
  /** Sent to the customer when the booking is made. Null sends nothing. */
  confirmationSms: z.string().trim().max(600).nullable().default(null),
});

export const smsPayloadSchema = z.object({
  to: z.string().trim().min(8).max(20),
  body: z.string().trim().min(1).max(600),
  /** Appends a fresh photo-upload link to the message when it is sent. */
  includeUploadLink: z.boolean().default(false),
});

export const replyPayloadSchema = smsPayloadSchema.omit({ includeUploadLink: true });

export const callbackPayloadSchema = z.object({
  phone: z.string().trim().min(8).max(20),
  note: z.string().trim().max(500).default(""),
});

export type BookingPayload = z.infer<typeof bookingPayloadSchema>;
export type SmsPayload = z.infer<typeof smsPayloadSchema>;
export type ReplyPayload = z.infer<typeof replyPayloadSchema>;

export const PAYLOAD_SCHEMAS = {
  booking: bookingPayloadSchema,
  sms: smsPayloadSchema,
  reply: replyPayloadSchema,
  callback: callbackPayloadSchema,
} as const;

export type Proposal =
  | { kind: "booking"; payload: BookingPayload; rationale: string }
  | { kind: "sms"; payload: SmsPayload; rationale: string }
  | { kind: "reply"; payload: ReplyPayload; rationale: string }
  | { kind: "callback"; payload: z.infer<typeof callbackPayloadSchema>; rationale: string };

/** Placeholder replaced by a fresh upload link when the SMS is sent. */
export const UPLOAD_LINK_PLACEHOLDER = "{lenke}";

function signature(profile: BusinessProfile): string {
  return profile.name ? `\nHilsen ${profile.name}` : "";
}

function firstName(name: string | null): string {
  return name?.trim().split(/\s+/)[0] ?? "";
}

function parseFuture(value: string | null, now: Date): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > now.getTime() ? date : null;
}

export function proposeActions(input: {
  intake: Intake;
  profile: BusinessProfile;
  callerPhone: string | null;
  freeSlots: Interval[];
  now: Date;
}): Proposal[] {
  const { intake, profile } = input;
  if (intake.category === "spam") return [];

  const phone =
    normalizePhone(intake.callbackNumber ?? "") ?? normalizePhone(input.callerPhone ?? "") ?? null;
  const hello = firstName(intake.callerName) ? `Hei ${firstName(intake.callerName)}!` : "Hei!";
  const proposals: Proposal[] = [];

  // Urgent, or nothing else we can do without a number: the owner calls back.
  if (phone && (intake.urgency === "high" || intake.category === "emergency")) {
    proposals.push({
      kind: "callback",
      payload: { phone, note: intake.title },
      rationale: "Det haster. Ring tilbake så snart du kan.",
    });
  }

  if (!phone) return proposals;

  if (profile.bookingEnabled && intake.wantsAppointment) {
    const agreed = parseFuture(intake.agreedSlot, input.now);
    const start = agreed ?? input.freeSlots[0]?.start ?? null;
    if (start) {
      const end = new Date(start.getTime() + profile.appointmentMinutes * 60_000);
      const when = describeLocal(start, profile.timezone);
      proposals.push({
        kind: "booking",
        payload: {
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          title: [intake.title, intake.callerName].filter(Boolean).join(" – ").slice(0, 200) || "Avtale",
          customerName: intake.callerName ?? "",
          customerPhone: phone,
          address: intake.address ?? "",
          notes: intake.summary,
          confirmationSms: `${hello} Du har time ${when}${intake.address ? ` (${intake.address})` : ""}. Passer det ikke, svar på denne meldingen.${signature(profile)}`,
        },
        rationale: agreed
          ? `Innringeren sa ja til ${when}.`
          : `Innringeren vil ha en time. ${when} er første ledige tid${intake.preferredTimes.length ? `; de sa: «${intake.preferredTimes.join("», «")}»` : ""}.`,
      });
    }
  }

  const infoUrl = intake.wantsInfoLink ? (profile.infoUrl ?? profile.websiteUrl) : null;
  if (intake.wantsPhotoLink || infoUrl) {
    const lines = [hello];
    if (intake.wantsPhotoLink) {
      lines.push(`Her kan du laste opp bilder, så ser vi på det før vi tar kontakt: ${UPLOAD_LINK_PLACEHOLDER}`);
    }
    if (infoUrl) lines.push(`Mer informasjon: ${infoUrl}`);
    proposals.push({
      kind: "sms",
      payload: {
        to: phone,
        body: lines.join("\n") + signature(profile),
        includeUploadLink: intake.wantsPhotoLink,
      },
      rationale: intake.wantsPhotoLink
        ? "Bilder gjør det lettere å vurdere jobben før du ringer."
        : "Innringeren ville lese mer.",
    });
  }

  const reply = intake.suggestedReply.trim();
  const covered = proposals.some((proposal) => proposal.kind === "booking");
  if (reply && !covered) {
    proposals.push({
      kind: "reply",
      payload: {
        to: phone,
        body: reply.includes(profile.name) || !profile.name ? reply : `${reply}${signature(profile)}`,
      },
      rationale: intake.openQuestions.length
        ? `Utkast til svar. Åpne spørsmål: ${intake.openQuestions.join("; ")}`
        : "Utkast til svar til innringeren.",
    });
  }

  return proposals;
}
