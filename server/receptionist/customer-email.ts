import type { SupabaseClient } from "@supabase/supabase-js";

import { readEmailConfig, isAllowedRecipient, sendEmail } from "@/agent/lib/email";
import { errorFields, logger } from "@/lib/logger";

import type { BusinessProfile } from "./profile";
import { escapeHtml } from "./text";

/**
 * Email to a customer, from the business: its name as the sender, its own
 * address as reply-to, Humanframe's verified domain underneath. Logged
 * before it is sent, like every SMS.
 */

export type EmailOutcome =
  | { kind: "sent"; id: string | null }
  | { kind: "refused"; message: string }
  | { kind: "unknown"; message: string }
  | { kind: "unconfigured"; reason: string };

export function renderCustomerEmail(input: {
  businessName: string;
  body: string;
  link?: { url: string; label: string };
}): { text: string; html: string } {
  const paragraphs = input.body
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 14px">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const button = input.link
    ? `<p style="margin:24px 0"><a href="${escapeHtml(input.link.url)}" style="display:inline-block;background:#24493F;color:#F3F7F5;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">${escapeHtml(input.link.label)}</a></p>`
    : "";
  const html = `<div style="background:#F7F5F0;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#24201B">
<div style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:16px;padding:32px;border:1px solid #E7E2D9">
<p style="font-family:Georgia,serif;font-size:22px;margin:0 0 20px">${escapeHtml(input.businessName)}</p>
<div style="font-size:15px;line-height:1.6">${paragraphs}</div>
${button}
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#8A8378;text-align:center">Sendt via Humanframe</p>
</div>`;
  const text = input.link ? `${input.body}\n\n${input.link.label}: ${input.link.url}` : input.body;
  return { text, html };
}

export async function sendCustomerEmail(
  admin: SupabaseClient,
  input: {
    profile: BusinessProfile;
    to: string;
    subject: string;
    body: string;
    link?: { url: string; label: string };
    inquiryId?: string | null;
    actionId?: string | null;
  }
): Promise<EmailOutcome> {
  const config = readEmailConfig();
  if (!config?.enabled) return { kind: "unconfigured", reason: "RESEND_API_KEY/NOTIFICATIONS_ENABLED not set" };
  if (!isAllowedRecipient(config, input.to)) return { kind: "refused", message: "Not on NOTIFICATIONS_ALLOWLIST" };

  const { data: row, error } = await admin
    .from("customer_emails")
    .insert({
      workspace_id: input.profile.workspaceId,
      inquiry_id: input.inquiryId ?? null,
      action_id: input.actionId ?? null,
      to_email: input.to,
      subject: input.subject,
      body: input.body,
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !row) {
    logger.error("customer_email.log_failed", errorFields(error));
    return { kind: "refused", message: "Could not log the email" };
  }

  const rendered = renderCustomerEmail({
    businessName: input.profile.name || "Humanframe",
    body: input.body,
    link: input.link,
  });
  const result = await sendEmail({
    config,
    payload: {
      to: input.to,
      subject: input.subject,
      ...rendered,
      fromName: input.profile.name || undefined,
      replyTo: input.profile.contactEmail || undefined,
    },
    idempotencyKey: `customer-email/${row.id}`,
  });

  const outcome: EmailOutcome =
    result.kind === "sent" || result.kind === "duplicate"
      ? { kind: "sent", id: result.providerMessageId }
      : result.kind === "unknown"
        ? { kind: "unknown", message: "E-posttjenesten svarte ikke. E-posten kan ha blitt sendt." }
        : { kind: "refused", message: `Resend ${result.status}` };

  await admin
    .from("customer_emails")
    .update(
      outcome.kind === "sent"
        ? { status: "sent", provider_id: outcome.id }
        : { status: outcome.kind === "unknown" ? "unknown" : "failed", error: "message" in outcome ? outcome.message : null }
    )
    .eq("id", row.id);
  return outcome;
}
