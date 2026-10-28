import { after } from "next/server";

import { getServiceRoleClient } from "@/lib/supabase/server";
import { processInquiry } from "@/server/receptionist/processing";
import { getInquiry } from "@/server/receptionist/store";
import { forbidden, verifiedTwilioRequest } from "@/server/telephony/inbound";

/**
 * The recording of a call (both legs) or a voicemail is ready. Store where it
 * is, answer Twilio at once, and process it after the response: transcribe,
 * extract, propose, tell the owner.
 */

export const maxDuration = 300;

export async function POST(request: Request) {
  const verified = await verifiedTwilioRequest(request);
  if (!verified) return forbidden();
  const { params } = verified;

  const inquiryId = new URL(request.url).searchParams.get("inquiry") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(inquiryId)) return new Response(null, { status: 204 });
  if (params.RecordingStatus && params.RecordingStatus !== "completed") {
    return new Response(null, { status: 204 });
  }

  const admin = getServiceRoleClient();
  const inquiry = await getInquiry(admin, inquiryId);
  if (!inquiry || !params.RecordingUrl) return new Response(null, { status: 204 });

  const seconds = Number(params.RecordingDuration ?? "");
  const channels = Number(params.RecordingChannels ?? "");
  await admin
    .from("inquiries")
    .update({
      recording_sid: params.RecordingSid ?? null,
      recording_url: params.RecordingUrl,
      recording_seconds: Number.isFinite(seconds) ? Math.round(seconds) : null,
      recording_channels: Number.isFinite(channels) ? channels : null,
      ...(inquiry.endedAt ? {} : { ended_at: new Date().toISOString() }),
      ...(inquiry.durationSeconds === null && Number.isFinite(seconds)
        ? { duration_seconds: Math.round(seconds) }
        : {}),
    })
    .eq("id", inquiry.id);

  after(async () => {
    await processInquiry(admin, inquiry.id);
  });

  return new Response(null, { status: 204 });
}
