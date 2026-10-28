import { z } from "zod";

import { isValidTimeZone, parseClock, type Weekday } from "./time";

/**
 * The business profile: everything the receptionist knows about the business
 * it answers for. Learned from the website, corrected by the owner, and read
 * on every call.
 */

const clock = z
  .string()
  .trim()
  .refine((value) => parseClock(value) !== null, "HH:MM");

/** Opening hours per weekday: zero or more [open, close] pairs. */
const ranges = z
  .array(
    z
      .tuple([clock, clock])
      .refine(([open, close]) => parseClock(open)! < parseClock(close)!, "open < close")
  )
  .max(4)
  .optional();

export const openingHoursSchema = z.object({
  mon: ranges,
  tue: ranges,
  wed: ranges,
  thu: ranges,
  fri: ranges,
  sat: ranges,
  sun: ranges,
});

export type OpeningHours = Partial<Record<Weekday, [string, string][]>>;

const service = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  price: z.string().trim().max(120).default(""),
});

const faqEntry = z.object({
  q: z.string().trim().min(1).max(300),
  a: z.string().trim().min(1).max(1000),
});

const phone = z
  .string()
  .trim()
  .max(20)
  .transform((value) => normalizePhone(value) ?? value);

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .transform((value) => (value === "" ? null : value))
  .nullable()
  .refine((value) => value === null || /^https?:\/\//i.test(value), "http(s) URL");

/** What the owner may write. The server fills in the rest. */
export const profileInputSchema = z.object({
  name: z.string().trim().max(120).default(""),
  websiteUrl: optionalUrl.default(null),
  summary: z.string().trim().max(1500).default(""),
  services: z.array(service).max(40).default([]),
  prices: z.string().trim().max(3000).default(""),
  openingHours: openingHoursSchema.default({}),
  address: z.string().trim().max(300).default(""),
  serviceArea: z.string().trim().max(300).default(""),
  contactPhone: z.string().trim().max(40).default(""),
  contactEmail: z.string().trim().max(200).default(""),
  infoUrl: optionalUrl.default(null),
  faq: z.array(faqEntry).max(40).default([]),
  instructions: z.string().trim().max(3000).default(""),
  greeting: z.string().trim().max(400).default(""),
  ownerPhone: phone.nullable().default(null),
  notifySms: z.boolean().default(true),
  notifyEmail: z.boolean().default(true),
  smsSender: z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .refine((value) => value === null || /^[A-Za-z0-9 ]{1,11}$/.test(value), "max 11")
    .default(null),
  bookingEnabled: z.boolean().default(true),
  appointmentMinutes: z.number().int().min(10).max(600).default(60),
  bufferMinutes: z.number().int().min(0).max(240).default(0),
  minNoticeHours: z.number().int().min(0).max(336).default(2),
  timezone: z
    .string()
    .trim()
    .refine(isValidTimeZone, "IANA timezone")
    .default("Europe/Oslo"),
});

export type ProfileInput = z.infer<typeof profileInputSchema>;

export type BusinessProfile = ProfileInput & {
  workspaceId: string;
  calendarFeedToken: string;
  learnedFrom: string[];
  learnedAt: string | null;
  onboardedAt: string | null;
};

export type ProfileRow = {
  workspace_id: string;
  name: string;
  website_url: string | null;
  summary: string;
  services: unknown;
  prices: string;
  opening_hours: unknown;
  address: string;
  service_area: string;
  contact_phone: string;
  contact_email: string;
  info_url: string | null;
  faq: unknown;
  instructions: string;
  greeting: string;
  owner_phone: string | null;
  notify_sms: boolean;
  notify_email: boolean;
  sms_sender: string | null;
  booking_enabled: boolean;
  appointment_minutes: number;
  buffer_minutes: number;
  min_notice_hours: number;
  timezone: string;
  calendar_feed_token: string;
  learned_from: unknown;
  learned_at: string | null;
  onboarded_at: string | null;
};

export const PROFILE_COLUMNS =
  "workspace_id, name, website_url, summary, services, prices, opening_hours, " +
  "address, service_area, contact_phone, contact_email, info_url, faq, " +
  "instructions, greeting, owner_phone, notify_sms, notify_email, sms_sender, " +
  "booking_enabled, appointment_minutes, buffer_minutes, min_notice_hours, " +
  "timezone, calendar_feed_token, learned_from, learned_at, onboarded_at";

/** A profile that has never been saved: the defaults, for one workspace. */
export function emptyProfile(workspaceId: string, name = ""): BusinessProfile {
  return {
    ...profileInputSchema.parse({ name }),
    workspaceId,
    calendarFeedToken: "",
    learnedFrom: [],
    learnedAt: null,
    onboardedAt: null,
  };
}

/**
 * Reads a row leniently. A stored value that no longer matches the schema —
 * a field written by an older build — degrades to its default rather than
 * taking the receptionist down mid-call.
 */
export function profileFromRow(row: ProfileRow): BusinessProfile {
  const loose = <T,>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : fallback;
  };

  return {
    workspaceId: row.workspace_id,
    name: row.name,
    websiteUrl: row.website_url,
    summary: row.summary,
    services: loose(z.array(service), row.services, []),
    prices: row.prices,
    openingHours: loose(openingHoursSchema, row.opening_hours, {}) as OpeningHours,
    address: row.address,
    serviceArea: row.service_area,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    infoUrl: row.info_url,
    faq: loose(z.array(faqEntry), row.faq, []),
    instructions: row.instructions,
    greeting: row.greeting,
    ownerPhone: row.owner_phone,
    notifySms: row.notify_sms,
    notifyEmail: row.notify_email,
    smsSender: row.sms_sender,
    bookingEnabled: row.booking_enabled,
    appointmentMinutes: row.appointment_minutes,
    bufferMinutes: row.buffer_minutes,
    minNoticeHours: row.min_notice_hours,
    timezone: isValidTimeZone(row.timezone) ? row.timezone : "Europe/Oslo",
    calendarFeedToken: row.calendar_feed_token,
    learnedFrom: loose(z.array(z.string()), row.learned_from, []),
    learnedAt: row.learned_at,
    onboardedAt: row.onboarded_at,
  };
}

export function profileToRow(input: ProfileInput): Omit<
  ProfileRow,
  "workspace_id" | "calendar_feed_token" | "learned_from" | "learned_at" | "onboarded_at"
> {
  return {
    name: input.name,
    website_url: input.websiteUrl,
    summary: input.summary,
    services: input.services,
    prices: input.prices,
    opening_hours: input.openingHours,
    address: input.address,
    service_area: input.serviceArea,
    contact_phone: input.contactPhone,
    contact_email: input.contactEmail,
    info_url: input.infoUrl,
    faq: input.faq,
    instructions: input.instructions,
    greeting: input.greeting,
    owner_phone: input.ownerPhone,
    notify_sms: input.notifySms,
    notify_email: input.notifyEmail,
    sms_sender: input.smsSender,
    booking_enabled: input.bookingEnabled,
    appointment_minutes: input.appointmentMinutes,
    buffer_minutes: input.bufferMinutes,
    min_notice_hours: input.minNoticeHours,
    timezone: input.timezone,
  };
}

/**
 * A phone number in E.164, assuming Norway for a bare eight-digit number.
 * Returns null for anything that cannot be a phone number.
 */
export function normalizePhone(value: string, defaultCountry = "47"): string | null {
  const compact = value.replace(/[\s\-().]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return compact;
  if (/^00[1-9]\d{6,14}$/.test(compact)) return `+${compact.slice(2)}`;
  if (/^\d{8}$/.test(compact)) return `+${defaultCountry}${compact}`;
  if (/^47\d{8}$/.test(compact)) return `+${compact}`;
  return null;
}

/** Whether the profile says enough for the receptionist to be useful. */
export function profileReadiness(profile: BusinessProfile): {
  ready: boolean;
  missing: ("name" | "summary" | "hours" | "ownerPhone")[];
} {
  const missing: ("name" | "summary" | "hours" | "ownerPhone")[] = [];
  if (!profile.name.trim()) missing.push("name");
  if (!profile.summary.trim() && profile.services.length === 0) missing.push("summary");
  if (!Object.values(profile.openingHours).some((ranges) => (ranges?.length ?? 0) > 0)) {
    missing.push("hours");
  }
  if (!profile.ownerPhone) missing.push("ownerPhone");
  return { ready: missing.length === 0, missing };
}
