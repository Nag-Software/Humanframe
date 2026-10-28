import { getServiceRoleClient } from "@/lib/supabase/server";
import { buildVoicemailPrompt } from "@/server/receptionist/prompt";
import { getInquiry, loadProfile } from "@/server/receptionist/store";
import { callbackUrl, forbidden, verifiedTwilioRequest } from "@/server/telephony/inbound";
import { escapeXml, say, twimlResponse } from "@/server/telephony/twilio";

/**
 * Twilio reports how the <Dial> to the AI (stage=ai) or the voicemail
 * <Record> (stage=voicemail) ended, and asks what to do next.
 *
 * If the AI leg never connected — not configured, rejected, overloaded — the
 * caller is still on the line and is offered voicemail. A voicemail is an
 * inquiry like any other.
 */

const CONNECTED = new Set(["completed", "answered"]);

export async function POST(request: Request) {
  const verified = await verifiedTwilioRequest(request);
  if (!verified) return forbidden();
  const { params } = verified;

  const url = new URL(request.url);
  const inquiryId = url.searchParams.get("inquiry") ?? "";
  const stage = url.searchParams.get("stage");
  const admin = getServiceRoleClient();
  const inquiry = /^[0-9a-f-]{36}$/i.test(inquiryId) ? await getInquiry(admin, inquiryId) : null;
  if (!inquiry) return twimlResponse("<Hangup/>");

  if (stage === "ai" && !CONNECTED.has(params.DialCallStatus ?? "")) {
    const profile = await loadProfile(admin, inquiry.workspaceId);
    await admin.from("inquiries").update({ channel: "voicemail" }).eq("id", inquiry.id);
    return twimlResponse(
      say(buildVoicemailPrompt(profile)) +
        `<Record maxLength="120" playBeep="true" ` +
        `recordingStatusCallback="${escapeXml(callbackUrl("/api/telephony/recording", { inquiry: inquiry.id }))}" ` +
        `action="${escapeXml(callbackUrl("/api/telephony/dial-status", { inquiry: inquiry.id, stage: "voicemail" }))}"/>`
    );
  }

  const duration = Number(params.DialCallDuration ?? params.RecordingDuration ?? params.CallDuration ?? "");
  await admin
    .from("inquiries")
    .update({
      ended_at: new Date().toISOString(),
      ...(Number.isFinite(duration) && duration >= 0 ? { duration_seconds: Math.round(duration) } : {}),
    })
    .eq("id", inquiry.id)
    .is("ended_at", null);

  return twimlResponse("<Hangup/>");
}
