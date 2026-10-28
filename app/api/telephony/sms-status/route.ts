import { getServiceRoleClient } from "@/lib/supabase/server";
import { forbidden, verifiedTwilioRequest } from "@/server/telephony/inbound";

/** Delivery receipts for the SMS we sent: queued → sent → delivered / failed. */
export async function POST(request: Request) {
  const verified = await verifiedTwilioRequest(request);
  if (!verified) return forbidden();
  const { params } = verified;

  if (params.MessageSid && params.MessageStatus) {
    await getServiceRoleClient()
      .from("sms_messages")
      .update({
        status: params.MessageStatus,
        ...(params.ErrorCode ? { error: `Twilio ${params.ErrorCode}` } : {}),
      })
      .eq("provider_sid", params.MessageSid);
  }
  return new Response(null, { status: 204 });
}
