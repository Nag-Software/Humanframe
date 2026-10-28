import { getServiceRoleClient } from "@/lib/supabase/server";
import { errorFields, logger } from "@/lib/logger";
import { buildGreeting, buildVoicemailPrompt } from "@/server/receptionist/prompt";
import { normalizePhone } from "@/server/receptionist/profile";
import { findPhoneNumber, getInquiry, getInquiryByCallSid, loadProfile } from "@/server/receptionist/store";
import { callbackUrl, forbidden, verifiedTwilioRequest } from "@/server/telephony/inbound";
import { readSipConfig } from "@/server/telephony/openai-sip";
import { escapeXml, say, sipUri, twimlResponse } from "@/server/telephony/twilio";

/**
 * A forwarded call has arrived at one of our numbers.
 *
 * The number dialled decides the workspace. An inquiry row is opened at once,
 * keyed on the CallSid, so every later webhook about this call finds it. Then
 * the caller hears the greeting — immediately, so the line never rings into
 * silence — and the AI is dialled over SIP with the inquiry id in a header.
 * Both legs are recorded on separate channels for the transcript.
 *
 * If the AI is not configured the caller gets voicemail instead. Either way
 * the business gets an inquiry, never a lost call.
 */

const MAX_CALL_SECONDS = 12 * 60;

export async function POST(request: Request) {
  const verified = await verifiedTwilioRequest(request);
  if (!verified) return forbidden();
  const { params } = verified;

  const admin = getServiceRoleClient();
  const to = normalizePhone(params.To ?? "") ?? params.To ?? "";
  const number = await findPhoneNumber(admin, to);
  if (!number) {
    logger.warn("telephony.unknown_number", {});
    return twimlResponse(`${say("Dette nummeret er ikke i bruk.")}<Hangup/>`);
  }

  const profile = await loadProfile(admin, number.workspaceId);
  const callSid = params.CallSid ?? "";
  const caller = normalizePhone(params.From ?? "");

  // Twilio retries a webhook it did not get an answer to; the CallSid makes
  // the second attempt find the first row instead of opening another.
  let inquiry = callSid ? await getInquiryByCallSid(admin, callSid) : null;
  if (!inquiry) {
    const { data, error } = await admin
      .from("inquiries")
      .insert({
        workspace_id: number.workspaceId,
        phone_number_id: number.id,
        channel: "phone",
        caller_phone: caller,
        call_sid: callSid || null,
        title: "Anrop",
      })
      .select("id")
      .single<{ id: string }>();
    if (error && error.code !== "23505") {
      logger.error("telephony.inquiry_insert_failed", errorFields(error));
    }
    // On a unique violation the retry's row is the one to use.
    inquiry = data
      ? await getInquiry(admin, data.id)
      : callSid
        ? await getInquiryByCallSid(admin, callSid)
        : null;
  }
  if (!inquiry) {
    // Never drop a caller on the floor because our database hiccuped.
    return twimlResponse(
      `${say(buildVoicemailPrompt(profile))}<Record maxLength="120" playBeep="true"/>`
    );
  }

  const recordingCallback = callbackUrl("/api/telephony/recording", { inquiry: inquiry.id });
  const sip = readSipConfig();

  if (!sip) {
    return twimlResponse(
      say(buildVoicemailPrompt(profile)) +
        `<Record maxLength="120" playBeep="true" recordingStatusCallback="${escapeXml(recordingCallback)}" ` +
        `action="${escapeXml(callbackUrl("/api/telephony/dial-status", { inquiry: inquiry.id, stage: "voicemail" }))}"/>`
    );
  }

  const uri = sipUri({
    projectId: sip.projectId,
    headers: { "X-Humanframe-Inquiry": inquiry.id },
  });

  return twimlResponse(
    say(buildGreeting(profile)) +
      `<Dial answerOnBridge="true" timeLimit="${MAX_CALL_SECONDS}" timeout="15" ` +
      `record="record-from-answer-dual" ` +
      `recordingStatusCallback="${escapeXml(recordingCallback)}" ` +
      `recordingStatusCallbackEvent="completed" ` +
      `action="${escapeXml(callbackUrl("/api/telephony/dial-status", { inquiry: inquiry.id, stage: "ai" }))}">` +
      `<Sip>${escapeXml(uri)}</Sip>` +
      `</Dial>`
  );
}
