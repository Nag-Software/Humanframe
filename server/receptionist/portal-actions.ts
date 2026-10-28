import type { SupabaseClient } from "@supabase/supabase-js";

import { readEmailConfig, isAllowedRecipient, sendEmail } from "@/agent/lib/email";
import { errorFields, logger } from "@/lib/logger";

import { inquiryUrl, workspaceOwnerEmails } from "./notify";
import type { BusinessProfile } from "./profile";
import { sendLoggedSms } from "./sms";
import { escapeHtml } from "./text";

/**
 * What a customer can do on their page. Each one is small, idempotent where
 * it matters, and tells the owner — the customer acting is the moment the
 * owner most wants to know about.
 */

export async function alertOwner(
  admin: SupabaseClient,
  input: { profile: BusinessProfile; inquiryId: string; text: string; subject: string }
): Promise<void> {
  const url = inquiryUrl(input.inquiryId);
  if (input.profile.notifySms && input.profile.ownerPhone) {
    await sendLoggedSms(admin, {
      profile: input.profile,
      to: input.profile.ownerPhone,
      body: `${input.text} ${url}`,
      audience: "owner",
      inquiryId: input.inquiryId,
      from: process.env.TWILIO_NOTIFY_FROM || null,
    }).catch((error: unknown) => logger.warn("portal.owner_sms_failed", errorFields(error)));
  }
  const config = readEmailConfig();
  if (!input.profile.notifyEmail || !config?.enabled) return;
  for (const to of await workspaceOwnerEmails(admin, input.profile.workspaceId)) {
    if (!isAllowedRecipient(config, to)) continue;
    await sendEmail({
      config,
      payload: {
        to,
        subject: input.subject,
        text: `${input.text}\n\n${url}`,
        html: `<p>${escapeHtml(input.text)}</p><p><a href="${escapeHtml(url)}">Åpne forespørselen</a></p>`,
      },
      idempotencyKey: `portal-alert/${input.inquiryId}/${input.subject}/${to}`.slice(0, 250),
    }).catch((error: unknown) => logger.warn("portal.owner_email_failed", errorFields(error)));
  }
}

export type QuoteDecision = { ok: true } | { ok: false; error: "not_found" | "not_open" };

export async function decideQuote(
  admin: SupabaseClient,
  input: {
    profile: BusinessProfile;
    inquiryId: string;
    quoteId: string;
    accept: boolean;
    reason?: string;
  }
): Promise<QuoteDecision> {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const { data } = await admin
    .from("quotes")
    .update(
      input.accept
        ? { status: "accepted", accepted_at: now }
        : { status: "declined", declined_at: now, decline_reason: input.reason?.slice(0, 500) ?? null }
    )
    .eq("id", input.quoteId)
    .eq("inquiry_id", input.inquiryId)
    .eq("status", "sent")
    .gte("valid_until", today)
    .select("number, title, total, customer_name")
    .maybeSingle<{ number: number; title: string; total: number | string; customer_name: string }>();
  if (!data) {
    const { data: exists } = await admin.from("quotes").select("id").eq("id", input.quoteId).eq("inquiry_id", input.inquiryId).maybeSingle();
    return { ok: false, error: exists ? "not_open" : "not_found" };
  }

  const amount = Math.round(Number(data.total)).toLocaleString("nb-NO");
  const who = data.customer_name || "Kunden";
  await alertOwner(admin, {
    profile: input.profile,
    inquiryId: input.inquiryId,
    subject: input.accept ? `Tilbud ${data.number} godtatt` : `Tilbud ${data.number} avslått`,
    text: input.accept
      ? `${who} godtok tilbud ${data.number} (${data.title}, ${amount} kr).`
      : `${who} avslo tilbud ${data.number}${input.reason ? `: «${input.reason.slice(0, 200)}»` : "."}`,
  });
  return { ok: true };
}

/** The customer picks a time: a booking proposal for the owner to confirm. */
export async function requestTime(
  admin: SupabaseClient,
  input: {
    profile: BusinessProfile;
    inquiryId: string;
    start: Date;
    customerName: string;
    customerPhone: string | null;
    address: string;
    title: string;
  }
): Promise<{ ok: true } | { ok: false; error: "past" | "exists" }> {
  if (input.start.getTime() < Date.now()) return { ok: false, error: "past" };

  // One open time request per inquiry; a new pick replaces the old one.
  await admin
    .from("inquiry_actions")
    .delete()
    .eq("inquiry_id", input.inquiryId)
    .eq("kind", "booking")
    .eq("status", "proposed");

  const end = new Date(input.start.getTime() + input.profile.appointmentMinutes * 60_000);
  const when = new Intl.DateTimeFormat("nb-NO", {
    timeZone: input.profile.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(input.start);
  const first = input.customerName.trim().split(/\s+/)[0];

  const { error } = await admin.from("inquiry_actions").insert({
    workspace_id: input.profile.workspaceId,
    inquiry_id: input.inquiryId,
    kind: "booking",
    payload: {
      startsAt: input.start.toISOString(),
      endsAt: end.toISOString(),
      title: [input.title, input.customerName].filter(Boolean).join(" – ").slice(0, 200) || "Avtale",
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      address: input.address,
      notes: "Valgt av kunden på kundesiden.",
      confirmationSms: input.customerPhone
        ? `${first ? `Hei ${first}!` : "Hei!"} Vi bekrefter ${when}. Passer det ikke, svar på denne meldingen.${input.profile.name ? `\nHilsen ${input.profile.name}` : ""}`
        : null,
    },
    rationale: `Kunden valgte ${when} på kundesiden.`,
  });
  if (error) return { ok: false, error: "exists" };

  await admin.from("inquiries").update({ status: "open" }).eq("id", input.inquiryId);
  await alertOwner(admin, {
    profile: input.profile,
    inquiryId: input.inquiryId,
    subject: "Kunden valgte en tid",
    text: `${input.customerName || "Kunden"} vil ha ${when}. Bekreft med ett trykk.`,
  });
  return { ok: true };
}

export async function postCustomerMessage(
  admin: SupabaseClient,
  input: { profile: BusinessProfile; inquiryId: string; text: string; customerName: string }
): Promise<void> {
  const text = input.text.trim().slice(0, 2000);
  if (!text) return;
  const { data } = await admin.from("inquiries").select("transcript").eq("id", input.inquiryId).single<{ transcript: string }>();
  await admin
    .from("inquiries")
    .update({ transcript: `${data?.transcript ?? ""}\nKunde (kundesiden): ${text}`.trim(), status: "open" })
    .eq("id", input.inquiryId);
  await alertOwner(admin, {
    profile: input.profile,
    inquiryId: input.inquiryId,
    subject: "Ny melding fra kunden",
    text: `${input.customerName || "Kunden"} skrev: «${text.slice(0, 280)}»`,
  });
}
