import { errorFields, logger } from "@/lib/logger";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { loadAvailability } from "@/server/receptionist/availability";
import { buildReceptionistInstructions } from "@/server/receptionist/prompt";
import { callerHistory, getInquiry, loadProfile } from "@/server/receptionist/store";
import {
  acceptCall,
  readIncomingCall,
  readSipConfig,
  rejectCall,
  verifyInquiryProof,
  verifyOpenAIWebhook,
} from "@/server/telephony/openai-sip";

/**
 * OpenAI asks what the AI on this call should be.
 *
 * The call reached OpenAI through our own Twilio TwiML, which put the inquiry
 * id in a SIP header. That id — not anything the caller controls — decides
 * the workspace. The answer is the receptionist's instructions, built from
 * the business profile, the caller's history and the free slots.
 *
 * This runs while the caller hears the greeting, so the calendar read has a
 * short deadline (see loadAvailability).
 */

export const maxDuration = 30;

export async function POST(request: Request) {
  const config = readSipConfig();
  if (!config) return new Response("Not configured", { status: 503 });

  const body = await request.text();
  const event = verifyOpenAIWebhook({
    secret: config.webhookSecret,
    body,
    id: request.headers.get("webhook-id"),
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
  });
  if (!event) return new Response("Forbidden", { status: 403 });

  const call = readIncomingCall(event);
  // Other event types are acknowledged and ignored.
  if (!call) return new Response(null, { status: 200 });

  const inquiryId = call.headers["x-humanframe-inquiry"];
  if (
    !inquiryId ||
    !/^[0-9a-f-]{36}$/i.test(inquiryId) ||
    !verifyInquiryProof(config, inquiryId, call.headers["x-humanframe-proof"])
  ) {
    logger.warn("sip.call_without_inquiry", {});
    await rejectCall(config, call.callId, 403);
    return new Response(null, { status: 200 });
  }

  try {
    const admin = getServiceRoleClient();
    // Claim the inquiry for this call in one conditional update: a replayed
    // or concurrent webhook finds it taken and must not open a second AI leg.
    const { data: claimed } = await admin
      .from("inquiries")
      .update({ provider_call_id: call.callId })
      .eq("id", inquiryId)
      .is("provider_call_id", null)
      .select("id")
      .maybeSingle<{ id: string }>();
    const inquiry = claimed ? await getInquiry(admin, inquiryId) : null;
    if (!inquiry) {
      await rejectCall(config, call.callId, 486);
      return new Response(null, { status: 200 });
    }

    const profile = await loadProfile(admin, inquiry.workspaceId);
    const now = new Date();
    const [history, availability] = await Promise.all([
      inquiry.callerPhone
        ? callerHistory(admin, inquiry.workspaceId, inquiry.callerPhone, inquiry.id)
        : Promise.resolve([]),
      profile.bookingEnabled
        ? loadAvailability(admin, profile, { now, calendarTimeoutMs: 2500 })
        : Promise.resolve({ slots: [], busy: [], known: true, calendarConnected: false }),
    ]);

    const instructions = buildReceptionistInstructions({
      profile,
      now,
      callerPhone: inquiry.callerPhone,
      history,
      slots: availability.slots,
      slotsKnown: availability.known,
    });

    const accepted = await acceptCall(config, call.callId, { instructions });
    await admin
      .from("inquiries")
      .update(
        accepted
          ? { answered_at: now.toISOString() }
          : { processing_error: "AI did not accept the call" }
      )
      .eq("id", inquiry.id);
  } catch (error) {
    logger.error("sip.incoming_failed", errorFields(error));
    // Rejecting makes Twilio's <Dial> fail, and dial-status turns that into
    // voicemail: the caller still gets heard.
    await rejectCall(config, call.callId, 500);
  }

  return new Response(null, { status: 200 });
}
