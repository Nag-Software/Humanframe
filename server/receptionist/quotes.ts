import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { BusinessProfile, PriceItem } from "./profile";

/**
 * Quotes: drafted from the owner's own price list, approved in the queue,
 * accepted by the customer on their page.
 *
 * The model may suggest lines, but a line only survives if its unit price is
 * one the owner actually wrote down. A quote never contains a price the
 * business did not set.
 */

export const VAT_RATE = 0.25;

export const quoteLineSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.number().positive().max(100_000),
  unit: z.enum(["stk", "time", "m2", "lm", "fast"]).default("stk"),
  unitPrice: z.number().nonnegative().max(10_000_000),
});

export type QuoteLine = z.infer<typeof quoteLineSchema>;

export const quotePayloadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  lines: z.array(quoteLineSchema).min(1).max(40),
  notes: z.string().trim().max(2000).default(""),
  customerName: z.string().trim().max(120).default(""),
  customerEmail: z.email().nullable().default(null),
  customerPhone: z.string().trim().max(20).nullable().default(null),
  validDays: z.number().int().min(1).max(365).default(30),
});

export type QuotePayload = z.infer<typeof quotePayloadSchema>;

export type QuoteTotals = { subtotal: number; vat: number; total: number };

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Totals the Norwegian way. With prices including VAT (the norm toward
 * consumers) the total is the sum and VAT is its fifth; without, VAT is
 * added on top.
 */
export function quoteTotals(lines: QuoteLine[], pricesIncludeVat: boolean): QuoteTotals {
  const sum = round2(lines.reduce((acc, line) => acc + line.quantity * line.unitPrice, 0));
  if (pricesIncludeVat) {
    const vat = round2(sum - sum / (1 + VAT_RATE));
    return { subtotal: round2(sum - vat), vat, total: sum };
  }
  const vat = round2(sum * VAT_RATE);
  return { subtotal: sum, vat, total: round2(sum + vat) };
}

/** Keeps only lines priced from the owner's list, and fixes their units. */
export function groundLines(
  suggested: { description: string; quantity: number; priceItem: string }[],
  priceItems: PriceItem[]
): QuoteLine[] {
  const byName = new Map(priceItems.map((item) => [item.name.trim().toLowerCase(), item]));
  const lines: QuoteLine[] = [];
  for (const suggestion of suggested) {
    const item = byName.get(suggestion.priceItem.trim().toLowerCase());
    if (!item) continue;
    const quantity = Number.isFinite(suggestion.quantity) && suggestion.quantity > 0 ? suggestion.quantity : 1;
    const parsed = quoteLineSchema.safeParse({
      description: suggestion.description.trim() || item.name,
      quantity: Math.round(quantity * 100) / 100,
      unit: item.unit,
      unitPrice: item.price,
    });
    if (parsed.success) lines.push(parsed.data);
  }
  return lines.slice(0, 20);
}

export function addDaysIso(from: Date, days: number): string {
  const date = new Date(from.getTime() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

export type Quote = {
  id: string;
  workspaceId: string;
  inquiryId: string;
  number: number;
  status: "sent" | "accepted" | "declined" | "expired" | "withdrawn";
  title: string;
  lines: QuoteLine[];
  notes: string;
  terms: string;
  pricesIncludeVat: boolean;
  subtotal: number;
  vat: number;
  total: number;
  validUntil: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  sentAt: string;
  viewedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
};

type QuoteRow = {
  id: string;
  workspace_id: string;
  inquiry_id: string;
  number: number;
  status: Quote["status"];
  title: string;
  lines: unknown;
  notes: string;
  terms: string;
  prices_include_vat: boolean;
  subtotal: number | string;
  vat: number | string;
  total: number | string;
  valid_until: string;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  sent_at: string;
  viewed_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
};

export const QUOTE_COLUMNS =
  "id, workspace_id, inquiry_id, number, status, title, lines, notes, terms, " +
  "prices_include_vat, subtotal, vat, total, valid_until, customer_name, " +
  "customer_email, customer_phone, sent_at, viewed_at, accepted_at, declined_at, decline_reason";

export function toQuote(row: QuoteRow): Quote {
  const lines = z.array(quoteLineSchema).safeParse(row.lines);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    inquiryId: row.inquiry_id,
    number: row.number,
    // A sent quote past its date reads as expired without a sweep to flip it.
    status:
      row.status === "sent" && row.valid_until < new Date().toISOString().slice(0, 10) ? "expired" : row.status,
    title: row.title,
    lines: lines.success ? lines.data : [],
    notes: row.notes,
    terms: row.terms,
    pricesIncludeVat: row.prices_include_vat,
    subtotal: Number(row.subtotal),
    vat: Number(row.vat),
    total: Number(row.total),
    validUntil: row.valid_until,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    sentAt: row.sent_at,
    viewedAt: row.viewed_at,
    acceptedAt: row.accepted_at,
    declinedAt: row.declined_at,
    declineReason: row.decline_reason,
  };
}

export async function listQuotes(
  client: SupabaseClient,
  workspaceId: string,
  options: { inquiryId?: string; limit?: number } = {}
): Promise<Quote[]> {
  let query = client
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("sent_at", { ascending: false })
    .limit(options.limit ?? 100);
  if (options.inquiryId) query = query.eq("inquiry_id", options.inquiryId);
  const { data } = await query.returns<QuoteRow[]>();
  return (data ?? []).map(toQuote);
}

/** Writes the quote for an approved proposal. Idempotent on the action. */
export async function createQuote(
  admin: SupabaseClient,
  input: {
    profile: BusinessProfile;
    inquiryId: string;
    actionId: string;
    payload: QuotePayload;
    userId: string | null;
  }
): Promise<Quote> {
  const { data: existing } = await admin
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("action_id", input.actionId)
    .maybeSingle<QuoteRow>();
  if (existing) return toQuote(existing);

  const { data: number, error: numberError } = await admin.rpc("next_quote_number", {
    p_workspace: input.profile.workspaceId,
  });
  if (numberError || typeof number !== "number") throw new Error("Could not number the quote");

  const totals = quoteTotals(input.payload.lines, input.profile.pricesIncludeVat);
  const { data, error } = await admin
    .from("quotes")
    .insert({
      workspace_id: input.profile.workspaceId,
      inquiry_id: input.inquiryId,
      action_id: input.actionId,
      number,
      title: input.payload.title,
      lines: input.payload.lines,
      notes: input.payload.notes,
      terms: input.profile.quoteTerms,
      prices_include_vat: input.profile.pricesIncludeVat,
      subtotal: totals.subtotal,
      vat: totals.vat,
      total: totals.total,
      valid_until: addDaysIso(new Date(), input.payload.validDays),
      customer_name: input.payload.customerName,
      customer_email: input.payload.customerEmail,
      customer_phone: input.payload.customerPhone,
      created_by: input.userId,
    })
    .select(QUOTE_COLUMNS)
    .single<QuoteRow>();
  if (error || !data) throw new Error("Could not save the quote");
  return toQuote(data);
}
