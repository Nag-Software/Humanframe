import { createHmac, timingSafeEqual } from "node:crypto";

import { logger } from "@/lib/logger";

/**
 * The OpenAI Realtime SIP seam: the AI voice on the phone.
 *
 * Twilio dials `sip:<project>@sip.api.openai.com`. OpenAI then calls our
 * webhook with `realtime.call.incoming`, and we answer with the session the
 * call should have — instructions, voice — by accepting it over REST. Nothing
 * long-lived runs on our side during the call, which is what lets this live
 * on serverless functions: the transcript comes afterwards, from the
 * recording Twilio makes of both legs.
 *
 * This is a different OpenAI surface from the browser Call
 * (server/call/openai-live.ts, `/v1/live/sessions` over WebRTC). Wire details
 * relied on, from OpenAI's Realtime SIP guide (verify with a test call before
 * go-live; see docs/RECEPTIONIST.md):
 *
 *   webhook  { type: "realtime.call.incoming",
 *              data: { call_id, sip_headers: [{ name, value }] } }
 *            signed per Standard Webhooks: webhook-id, webhook-timestamp,
 *            webhook-signature = "v1,<base64 HMAC-SHA256(secret,
 *            `${id}.${timestamp}.${body}`)>", secret "whsec_<base64>"
 *   accept   POST /v1/realtime/calls/{call_id}/accept  { type: "realtime", model, instructions, audio }
 *   reject   POST /v1/realtime/calls/{call_id}/reject  { status_code }
 */

const API = "https://api.openai.com/v1/realtime/calls";
const TOLERANCE_SECONDS = 5 * 60;

export type SipConfig = {
  apiKey: string;
  projectId: string;
  webhookSecret: string;
  model: string;
  voice: string;
};

export function readSipConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): SipConfig | null {
  const apiKey = env.OPENAI_API_KEY;
  const projectId = env.OPENAI_PROJECT_ID;
  const webhookSecret = env.OPENAI_WEBHOOK_SECRET;
  if (!apiKey || !projectId || !webhookSecret) return null;
  return {
    apiKey,
    projectId,
    webhookSecret,
    model: env.PHONE_MODEL || "gpt-realtime",
    voice: env.PHONE_VOICE || "marin",
  };
}

export type IncomingCall = {
  callId: string;
  headers: Record<string, string>;
};

/** Standard Webhooks verification. Returns the parsed event or null. */
export function verifyOpenAIWebhook(input: {
  secret: string;
  body: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  now?: Date;
}): unknown | null {
  if (!input.id || !input.timestamp || !input.signature) return null;

  const timestamp = Number(input.timestamp);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > TOLERANCE_SECONDS) {
    return null;
  }

  const key = Buffer.from(input.secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${input.id}.${input.timestamp}.${input.body}`)
    .digest();

  // The header may carry several space-separated signatures during rotation.
  const valid = input.signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) return null;

  try {
    return JSON.parse(input.body);
  } catch {
    return null;
  }
}

/**
 * Proof that a SIP call carrying an inquiry id came through our own TwiML.
 * The webhook signature only proves OpenAI sent the event; anyone who knows
 * the project id can dial the SIP URI and set headers. This HMAC, keyed on a
 * secret only we hold, is what ties the header to a call we placed.
 */
export function inquiryProof(config: SipConfig, inquiryId: string): string {
  return createHmac("sha256", config.webhookSecret).update(`inquiry:${inquiryId}`).digest("base64url");
}

export function verifyInquiryProof(config: SipConfig, inquiryId: string, proof: string | undefined): boolean {
  if (!proof) return false;
  const expected = Buffer.from(inquiryProof(config, inquiryId));
  const given = Buffer.from(proof);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function signOpenAIWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** Pulls the call id and SIP headers out of a verified event. */
export function readIncomingCall(event: unknown): IncomingCall | null {
  const record = event as {
    type?: string;
    data?: { call_id?: string; sip_headers?: { name?: string; value?: string }[] };
  } | null;
  if (record?.type !== "realtime.call.incoming" || !record.data?.call_id) return null;

  const headers: Record<string, string> = {};
  for (const header of record.data.sip_headers ?? []) {
    if (header.name && typeof header.value === "string") {
      headers[header.name.toLowerCase()] = header.value;
    }
  }
  return { callId: record.data.call_id, headers };
}

export async function acceptCall(
  config: SipConfig,
  callId: string,
  session: { instructions: string }
): Promise<boolean> {
  const response = await fetch(`${API}/${encodeURIComponent(callId)}/accept`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "realtime",
      model: config.model,
      instructions: session.instructions,
      audio: { output: { voice: config.voice } },
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => {
    logger.error("sip.accept_unreachable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  if (!response?.ok) {
    // The body can echo the instructions; log the status only.
    logger.error("sip.accept_rejected", { status: response?.status ?? null });
    return false;
  }
  return true;
}

export async function rejectCall(config: SipConfig, callId: string, statusCode = 486): Promise<void> {
  await fetch(`${API}/${encodeURIComponent(callId)}/reject`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ status_code: statusCode }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}
