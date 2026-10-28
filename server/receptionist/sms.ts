import type { SupabaseClient } from "@supabase/supabase-js";

import { appOrigin } from "@/agent/lib/email-template";
import { errorFields, logger } from "@/lib/logger";
import { readTwilioConfig, sendSms, type SmsResult } from "@/server/telephony/twilio";

import type { BusinessProfile } from "./profile";
import { listPhoneNumbers } from "./store";

/**
 * Every SMS the receptionist sends goes through here, so every one is logged
 * — the weekly report counts them, and the inquiry shows what the customer
 * actually received.
 *
 * The row is written before the provider is called. If the process dies
 * between the two, the row says `sending` forever, which is the honest state:
 * the message may or may not have left.
 */

export type SendOutcome = SmsResult | { kind: "unconfigured"; reason: string };

export async function senderFor(
  admin: SupabaseClient,
  profile: BusinessProfile
): Promise<string | null> {
  if (profile.smsSender) return profile.smsSender;
  const [number] = await listPhoneNumbers(admin, profile.workspaceId);
  return number?.e164 ?? process.env.TWILIO_DEFAULT_SMS_FROM ?? null;
}

export async function sendLoggedSms(
  admin: SupabaseClient,
  input: {
    profile: BusinessProfile;
    to: string;
    body: string;
    audience: "customer" | "owner";
    inquiryId?: string | null;
    actionId?: string | null;
    /** Owner notifications come from the service, not the business's own sender. */
    from?: string | null;
  }
): Promise<SendOutcome> {
  const config = readTwilioConfig();
  if (!config) return { kind: "unconfigured", reason: "TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN missing" };

  const from = input.from ?? (await senderFor(admin, input.profile));
  if (!from) return { kind: "unconfigured", reason: "No sender: no phone number and no SMS sender name" };

  const { data: row, error } = await admin
    .from("sms_messages")
    .insert({
      workspace_id: input.profile.workspaceId,
      inquiry_id: input.inquiryId ?? null,
      action_id: input.actionId ?? null,
      direction: "outbound",
      audience: input.audience,
      to_phone: input.to,
      from_phone: from,
      body: input.body,
      status: "sending",
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !row) {
    logger.error("sms.log_failed", errorFields(error));
    return { kind: "refused", status: 0, code: null, message: "Could not log the message" };
  }

  const origin = appOrigin();
  const result = await sendSms(config, {
    to: input.to,
    from,
    body: input.body,
    statusCallback: origin ? `${origin}/api/telephony/sms-status` : undefined,
  });

  await admin
    .from("sms_messages")
    .update(
      result.kind === "sent"
        ? { provider_sid: result.sid, status: result.status }
        : result.kind === "refused"
          ? { status: "failed", error: result.message }
          : { status: "unknown", error: result.error }
    )
    .eq("id", row.id);

  return result;
}
