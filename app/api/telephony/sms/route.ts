import { after } from "next/server";

import { errorFields, logger } from "@/lib/logger";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { inquiryUrl } from "@/server/receptionist/notify";
import { processInquiry } from "@/server/receptionist/processing";
import { normalizePhone } from "@/server/receptionist/profile";
import { sendLoggedSms } from "@/server/receptionist/sms";
import { findPhoneNumber, loadProfile } from "@/server/receptionist/store";
import { forbidden, verifiedTwilioRequest } from "@/server/telephony/inbound";
import { twimlResponse } from "@/server/telephony/twilio";

/**
 * A customer texted one of our numbers — usually a reply to something the
 * receptionist sent.
 *
 * A reply within a week joins that customer's open inquiry and is passed on
 * to the owner as it is. Anything else opens a new inquiry and goes through
 * the same intake as a call.
 */

export const maxDuration = 120;

const THREAD_WINDOW_MS = 7 * 86_400_000;

export async function POST(request: Request) {
  const verified = await verifiedTwilioRequest(request);
  if (!verified) return forbidden();
  const { params } = verified;

  const admin = getServiceRoleClient();
  const to = normalizePhone(params.To ?? "") ?? params.To ?? "";
  const from = normalizePhone(params.From ?? "") ?? params.From ?? "";
  const body = (params.Body ?? "").trim().slice(0, 1600);
  const number = await findPhoneNumber(admin, to);
  if (!number || !from || !body) return twimlResponse("");

  // The MessageSid is unique: a retried webhook stops here.
  const { data: logged, error: logError } = await admin
    .from("sms_messages")
    .insert({
      workspace_id: number.workspaceId,
      direction: "inbound",
      to_phone: to,
      from_phone: from,
      body,
      provider_sid: params.MessageSid ?? null,
      status: "received",
    })
    .select("id")
    .maybeSingle<{ id: string }>();
  if (logError?.code === "23505") return twimlResponse("");
  if (logError || !logged) {
    logger.error("sms.inbound_log_failed", errorFields(logError));
  }

  const profile = await loadProfile(admin, number.workspaceId);

  const { data: recent } = await admin
    .from("inquiries")
    .select("id, transcript, caller_name, title")
    .eq("workspace_id", number.workspaceId)
    .eq("caller_phone", from)
    .neq("status", "dismissed")
    .gte("started_at", new Date(Date.now() - THREAD_WINDOW_MS).toISOString())
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; transcript: string; caller_name: string | null; title: string }>();

  if (recent) {
    await admin
      .from("inquiries")
      .update({
        transcript: `${recent.transcript}\nInnringer (SMS): ${body}`.trim(),
        status: "open",
      })
      .eq("id", recent.id);
    if (logged) await admin.from("sms_messages").update({ inquiry_id: recent.id }).eq("id", logged.id);

    if (profile.notifySms && profile.ownerPhone) {
      after(async () => {
        await sendLoggedSms(admin, {
          profile,
          to: profile.ownerPhone!,
          body: `SMS fra ${recent.caller_name ?? from}: «${body.slice(0, 300)}» ${inquiryUrl(recent.id)}`,
          audience: "owner",
          inquiryId: recent.id,
          from: process.env.TWILIO_NOTIFY_FROM || null,
        });
      });
    }
    return twimlResponse("");
  }

  const { data: created, error } = await admin
    .from("inquiries")
    .insert({
      workspace_id: number.workspaceId,
      phone_number_id: number.id,
      channel: "sms",
      caller_phone: from,
      title: "SMS",
      transcript: `Innringer (SMS): ${body}`,
      ended_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !created) {
    logger.error("sms.inquiry_insert_failed", errorFields(error));
    return twimlResponse("");
  }
  if (logged) await admin.from("sms_messages").update({ inquiry_id: created.id }).eq("id", logged.id);

  after(async () => {
    await processInquiry(admin, created.id);
  });
  return twimlResponse("");
}
