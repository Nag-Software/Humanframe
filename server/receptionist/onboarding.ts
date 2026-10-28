import { generateObject } from "ai";
import { z } from "zod";

import { receptionistModel } from "@/agent/lib/models";

import { normalizePhone, openingHoursSchema, type ProfileInput } from "./profile";
import { crawlBusinessSite } from "./web";

/**
 * Onboarding from a website URL: the receptionist reads the business's own
 * site and drafts its profile. The owner then corrects the draft — nothing
 * here is trusted as fact until they save it.
 */

const MAX_CHARS_PER_PAGE = 12_000;
const MAX_CHARS_TOTAL = 40_000;

const learnedSchema = z.object({
  name: z.string().describe("The business's name as customers know it."),
  summary: z
    .string()
    .describe(
      "Two or three plain sentences, in Norwegian, a receptionist could say about what the business does and for whom."
    ),
  services: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().describe("One short sentence, or empty."),
        price: z.string().describe("Price exactly as the site states it, or empty."),
      })
    )
    .max(25),
  prices: z
    .string()
    .describe("Any other pricing the site states, verbatim and short. Empty if none. Never invent prices."),
  openingHours: z
    .object({
      mon: z.array(z.tuple([z.string(), z.string()])),
      tue: z.array(z.tuple([z.string(), z.string()])),
      wed: z.array(z.tuple([z.string(), z.string()])),
      thu: z.array(z.tuple([z.string(), z.string()])),
      fri: z.array(z.tuple([z.string(), z.string()])),
      sat: z.array(z.tuple([z.string(), z.string()])),
      sun: z.array(z.tuple([z.string(), z.string()])),
    })
    .describe('Per weekday, [["08:00","16:00"]] in 24h HH:MM. Empty arrays when closed or unknown.'),
  hoursFound: z.boolean().describe("True only if the site actually states opening hours."),
  address: z.string(),
  serviceArea: z.string().describe("Towns or regions served, if stated."),
  contactPhone: z.string(),
  contactEmail: z.string(),
  faq: z
    .array(z.object({ q: z.string(), a: z.string() }))
    .max(10)
    .describe("Questions callers are likely to ask, answered only from the site."),
});

export type LearnedProfile = {
  draft: Partial<ProfileInput>;
  sources: string[];
  hoursFound: boolean;
};

export async function learnFromWebsite(url: string): Promise<LearnedProfile> {
  const crawl = await crawlBusinessSite(url);

  let budget = MAX_CHARS_TOTAL;
  const corpus = crawl.pages
    .map((page) => {
      const text = page.text.slice(0, Math.min(MAX_CHARS_PER_PAGE, Math.max(0, budget)));
      budget -= text.length;
      return text ? `### ${page.url}\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  if (!corpus.trim()) {
    throw new Error("The website had no readable text");
  }

  const { object } = await generateObject({
    model: receptionistModel(),
    schema: learnedSchema,
    system: [
      "You read a small Norwegian business's website and fill in the profile its phone receptionist will use.",
      "Use only what the pages say. Leave a field empty rather than guess, and never invent a price or an opening hour.",
      "Write summary, service descriptions and FAQ answers in Norwegian bokmål.",
    ].join(" "),
    prompt: corpus,
  });

  return {
    draft: toDraft(object, crawl.pages[0]?.url ?? url),
    sources: crawl.pages.map((page) => page.url),
    hoursFound: object.hoursFound,
  };
}

/** Pure: the model's answer, made safe to merge into a profile. */
export function toDraft(
  learned: z.infer<typeof learnedSchema>,
  websiteUrl: string
): Partial<ProfileInput> {
  const hours = openingHoursSchema.safeParse(learned.hoursFound ? learned.openingHours : {});
  const phone = normalizePhone(learned.contactPhone);

  return {
    name: learned.name.trim().slice(0, 120),
    websiteUrl,
    infoUrl: websiteUrl,
    summary: learned.summary.trim().slice(0, 1500),
    services: learned.services
      .filter((service) => service.name.trim())
      .slice(0, 40)
      .map((service) => ({
        name: service.name.trim().slice(0, 120),
        description: service.description.trim().slice(0, 500),
        price: service.price.trim().slice(0, 120),
      })),
    prices: learned.prices.trim().slice(0, 3000),
    openingHours: hours.success ? hours.data : {},
    address: learned.address.trim().slice(0, 300),
    serviceArea: learned.serviceArea.trim().slice(0, 300),
    contactPhone: phone ?? learned.contactPhone.trim().slice(0, 40),
    contactEmail: learned.contactEmail.trim().slice(0, 200),
    faq: learned.faq
      .filter((entry) => entry.q.trim() && entry.a.trim())
      .map((entry) => ({ q: entry.q.trim().slice(0, 300), a: entry.a.trim().slice(0, 1000) })),
  };
}

/**
 * Merges a draft into what the owner already has. Fields the owner filled in
 * win: re-reading the website must never wipe out a correction.
 */
export function mergeDraft(current: ProfileInput, draft: Partial<ProfileInput>): ProfileInput {
  const merged = { ...current };
  const keys = Object.keys(draft) as (keyof ProfileInput)[];
  for (const key of keys) {
    const existing = current[key];
    const incoming = draft[key];
    if (incoming === undefined || incoming === null) continue;
    const empty =
      existing === null ||
      existing === "" ||
      (Array.isArray(existing) && existing.length === 0) ||
      (typeof existing === "object" &&
        existing !== null &&
        !Array.isArray(existing) &&
        Object.values(existing).every((value) => !value || (Array.isArray(value) && value.length === 0)));
    if (empty) {
      (merged as Record<string, unknown>)[key] = incoming;
    }
  }
  return merged;
}
