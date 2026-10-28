import { appOrigin } from "@/agent/lib/email-template";
import { errorFields, logger } from "@/lib/logger";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { LIMITS, rateLimitedResponse, takeRateLimit } from "@/server/rate-limit";
import { normalizePhone } from "@/server/receptionist/profile";
import { requireApiScope } from "@/server/receptionist/scope";
import { insertPhoneNumber, listPhoneNumbers } from "@/server/receptionist/store";
import { provisionNumber, readTwilioConfig } from "@/server/telephony/twilio";

/**
 * Gives the workspace its forwarding number: buys one on our Twilio account
 * and points it at the webhooks. Only numbers we bought can be attached here
 * — attaching a number typed into a form would let anyone route someone
 * else's calls into their workspace.
 */

export async function POST(request: Request) {
  const auth = await requireApiScope({ configure: true });
  if ("response" in auth) return auth.response;
  const { scope } = auth;

  const body = (await request.json().catch(() => ({}))) as { forwardedFrom?: string };
  const forwardedFrom = body.forwardedFrom ? normalizePhone(body.forwardedFrom) : null;

  const admin = getServiceRoleClient();
  const existing = await listPhoneNumbers(admin, scope.workspaceId);
  if (existing.length > 0) {
    if (forwardedFrom) {
      await admin.from("phone_numbers").update({ forwarded_from: forwardedFrom }).eq("id", existing[0].id);
    }
    return Response.json({ number: { ...existing[0], forwardedFrom: forwardedFrom ?? existing[0].forwardedFrom } });
  }

  const config = readTwilioConfig();
  const origin = appOrigin();
  if (!config || !origin) {
    return Response.json({ error: "telephony_unconfigured" }, { status: 503 });
  }
  if (!(await takeRateLimit(scope.client, LIMITS.receptionistNumber))) {
    return rateLimitedResponse(LIMITS.receptionistNumber);
  }

  try {
    const bought = await provisionNumber(config, {
      country: process.env.TWILIO_NUMBER_COUNTRY || "NO",
      voiceUrl: `${origin}/api/telephony/voice`,
      smsUrl: `${origin}/api/telephony/sms`,
      bundleSid: process.env.TWILIO_BUNDLE_SID || undefined,
      addressSid: process.env.TWILIO_ADDRESS_SID || undefined,
      friendlyName: `Humanframe ${scope.workspace.name}`,
    });
    const number = await insertPhoneNumber(admin, {
      workspaceId: scope.workspaceId,
      e164: bought.e164,
      providerSid: bought.sid,
      forwardedFrom,
    });
    logger.info("receptionist.number_provisioned", { workspaceId: scope.workspaceId });
    return Response.json({ number });
  } catch (error) {
    logger.error("receptionist.number_failed", errorFields(error));
    return Response.json(
      { error: "provision_failed", message: error instanceof Error ? error.message : "failed" },
      { status: 502 }
    );
  }
}
