import type { SupabaseClient } from "@supabase/supabase-js";

import { readEmailConfig, isAllowedRecipient, sendEmail } from "@/agent/lib/email";
import { appOrigin } from "@/agent/lib/email-template";
import { errorFields, logger } from "@/lib/logger";

import type { BusinessProfile } from "./profile";
import { sendLoggedSms } from "./sms";
import type { Inquiry } from "./store";
import { escapeHtml } from "./text";

/**
 * Telling the owner a call came in.
 *
 * The SMS is the one that matters: the owner is on a ladder, and a text with
 * the gist and a link to approve is the whole product in one message. Email
 * is the record. Both are claimed by setting `owner_notified_at` first, so a
 * retried processing run does not text the owner twice.
 */

export async function workspaceOwnerEmails(
  admin: SupabaseClient,
  workspaceId: string
): Promise<string[]> {
  const { data } = await admin
    .from("workspace_members")
    .select("users:user_id (email)")
    .eq("workspace_id", workspaceId)
    .in("role", ["owner", "admin"])
    .returns<{ users: { email: string | null } | null }[]>();
  return (data ?? [])
    .map((row) => row.users?.email)
    .filter((email): email is string => Boolean(email));
}

export function inquiryUrl(inquiryId: string): string {
  return `${appOrigin() ?? "http://localhost:3000"}/inbox/${inquiryId}`;
}

/** Pure: the owner's text. Short enough for one SMS segment where it can be. */
export function ownerSmsText(input: {
  inquiry: Pick<Inquiry, "title" | "callerName" | "callerPhone" | "urgency" | "channel">;
  proposals: number;
  url: string;
}): string {
  const who = input.inquiry.callerName ?? input.inquiry.callerPhone ?? "skjult nummer";
  const what = input.inquiry.title || (input.inquiry.channel === "sms" ? "SMS" : "Anrop");
  const urgent = input.inquiry.urgency === "high" ? "HASTER: " : "";
  const waiting =
    input.proposals > 0
      ? `${input.proposals} forslag venter på deg`
      : "Se detaljer";
  return `${urgent}${what} – ${who}. ${waiting}: ${input.url}`;
}

export async function notifyOwner(
  admin: SupabaseClient,
  input: { inquiry: Inquiry; profile: BusinessProfile; proposals: number }
): Promise<void> {
  const { data: claimed } = await admin
    .from("inquiries")
    .update({ owner_notified_at: new Date().toISOString() })
    .eq("id", input.inquiry.id)
    .is("owner_notified_at", null)
    .select("id")
    .maybeSingle<{ id: string }>();
  if (!claimed) return;

  const url = inquiryUrl(input.inquiry.id);
  const text = ownerSmsText({ inquiry: input.inquiry, proposals: input.proposals, url });

  if (input.profile.notifySms && input.profile.ownerPhone) {
    const result = await sendLoggedSms(admin, {
      profile: input.profile,
      to: input.profile.ownerPhone,
      body: text,
      audience: "owner",
      inquiryId: input.inquiry.id,
      // The owner's alert comes from the service sender, not the business's
      // own name: the business texting itself would read as a customer message.
      from: process.env.TWILIO_NOTIFY_FROM || null,
    });
    if (result.kind !== "sent") {
      logger.warn("receptionist.owner_sms_not_sent", { kind: result.kind });
    }
  }

  if (input.profile.notifyEmail) {
    const config = readEmailConfig();
    if (!config?.enabled) return;
    const recipients = (await workspaceOwnerEmails(admin, input.profile.workspaceId)).filter(
      (address) => isAllowedRecipient(config, address)
    );
    const subject = `${input.inquiry.urgency === "high" ? "Haster: " : ""}${input.inquiry.title || "Ny henvendelse"}`;
    const body = [
      input.inquiry.summary,
      "",
      `Fra: ${input.inquiry.callerName ?? ""} ${input.inquiry.callerPhone ?? "skjult nummer"}`.trim(),
      input.proposals > 0 ? `${input.proposals} forslag venter på godkjenning.` : "",
      url,
    ]
      .filter((line) => line !== null)
      .join("\n");

    for (const to of recipients) {
      const result = await sendEmail({
        config,
        payload: {
          to,
          subject,
          text: body,
          html: `<p>${escapeHtml(input.inquiry.summary)}</p><p>${escapeHtml(
            `${input.inquiry.callerName ?? ""} ${input.inquiry.callerPhone ?? "skjult nummer"}`
          )}</p><p><a href="${escapeHtml(url)}">${
            input.proposals > 0 ? `Se ${input.proposals} forslag` : "Åpne henvendelsen"
          }</a></p>`,
        },
        idempotencyKey: `inquiry-notify/${input.inquiry.id}/${to}`,
      }).catch((error: unknown) => {
        logger.error("receptionist.owner_email_failed", errorFields(error));
        return null;
      });
      if (result && result.kind !== "sent" && result.kind !== "duplicate") {
        logger.warn("receptionist.owner_email_not_sent", { kind: result.kind });
      }
    }
  }
}
