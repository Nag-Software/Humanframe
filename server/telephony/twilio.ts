import { createHmac, timingSafeEqual } from "node:crypto";

import { logger } from "@/lib/logger";

/**
 * The Twilio seam: the only file that knows Twilio's wire format.
 *
 * Twilio carries the phone network for the receptionist. The business keeps
 * its own number and sets "forward when busy / unanswered" to a Twilio number
 * we hold for it — no number porting. Twilio then:
 *
 *   1. asks /api/telephony/voice what to do with the call (TwiML below),
 *   2. dials the AI over SIP and records both legs on separate channels,
 *   3. reports the outcome to /api/telephony/dial-status and the recording
 *      to /api/telephony/recording,
 *   4. sends and receives the SMS.
 *
 * Every inbound request is verified with the account's auth token before it
 * is believed (verifyTwilioSignature). Outbound calls use the REST API with
 * HTTP basic auth.
 *
 * Wire details relied on, from Twilio's documentation (verify against a test
 * call before go-live; see docs/RECEPTIONIST.md):
 *  - X-Twilio-Signature = base64(HMAC-SHA1(authToken, url + Σ sorted(key+value)))
 *    over the exact URL Twilio requested, form parameters sorted by name;
 *  - <Dial record="record-from-answer-dual"> puts the calling party on
 *    channel 1 and the dialled party (the AI) on channel 2;
 *  - custom SIP headers ride on the SIP URI as `?X-Name=value`, and must
 *    start with `X-`;
 *  - a recording's media is `${RecordingUrl}.wav`, behind basic auth.
 */

const API = "https://api.twilio.com/2010-04-01";
const REQUEST_TIMEOUT_MS = 15_000;

export type TwilioConfig = {
  accountSid: string;
  /** Verifies inbound webhooks. Always the account's auth token. */
  authToken: string;
  /** REST credentials: an API key pair if set, else the account sid/token. */
  apiKeySid: string;
  apiKeySecret: string;
};

export function readTwilioConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return {
    accountSid,
    authToken,
    apiKeySid: env.TWILIO_API_KEY_SID || accountSid,
    apiKeySecret: env.TWILIO_API_KEY_SECRET || authToken,
  };
}

// ---------------------------------------------------------------------------
// Inbound: signature
// ---------------------------------------------------------------------------

export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>
): string {
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  return createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
}

/**
 * Checks the signature against each candidate URL. Behind a proxy the URL
 * Twilio dialled and the URL this process sees can differ in host or scheme,
 * so the configured public origin is tried as well as the request's own.
 */
export function verifyTwilioSignature(input: {
  authToken: string;
  signature: string | null;
  urls: string[];
  params: Record<string, string>;
}): boolean {
  if (!input.signature) return false;
  const given = Buffer.from(input.signature);
  return input.urls.some((url) => {
    const expected = Buffer.from(twilioSignature(input.authToken, url, input.params));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/** Form body → plain record. Twilio posts application/x-www-form-urlencoded. */
export async function readTwilioForm(request: Request): Promise<Record<string, string>> {
  const text = await request.text();
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    params[key] = value;
  }
  return params;
}

// ---------------------------------------------------------------------------
// TwiML
// ---------------------------------------------------------------------------

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Norwegian neural voice for what Twilio itself says. */
export const TWIML_VOICE = { language: "nb-NO", voice: "Polly.Ida-Neural" } as const;

export function say(text: string): string {
  return `<Say language="${TWIML_VOICE.language}" voice="${TWIML_VOICE.voice}">${escapeXml(text)}</Say>`;
}

export function twiml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

export function twimlResponse(body: string): Response {
  return new Response(twiml(body), {
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

/** The SIP URI the AI answers on, with our inquiry id riding along. */
export function sipUri(input: {
  projectId: string;
  headers: Record<string, string>;
}): string {
  const query = Object.entries(input.headers)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
  return `sip:${input.projectId}@sip.api.openai.com;transport=tls${query ? `?${query}` : ""}`;
}

// ---------------------------------------------------------------------------
// Outbound: REST
// ---------------------------------------------------------------------------

function authHeader(config: TwilioConfig): string {
  return `Basic ${Buffer.from(`${config.apiKeySid}:${config.apiKeySecret}`).toString("base64")}`;
}

async function rest(
  config: TwilioConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, string>
): Promise<Response> {
  const url = new URL(`${API}/Accounts/${config.accountSid}${path}`);
  const init: RequestInit = {
    method,
    headers: { authorization: authHeader(config) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (params && method === "GET") {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  } else if (params) {
    init.body = new URLSearchParams(params);
    (init.headers as Record<string, string>)["content-type"] = "application/x-www-form-urlencoded";
  }
  return fetch(url, init);
}

export type SmsResult =
  | { kind: "sent"; sid: string; status: string }
  /** Definitely not sent: bad number, bad sender, refused. */
  | { kind: "refused"; status: number; code: number | null; message: string }
  /** The request may have reached Twilio. Do not retry blindly. */
  | { kind: "unknown"; error: string };

export async function sendSms(
  config: TwilioConfig,
  input: { to: string; from: string; body: string; statusCallback?: string }
): Promise<SmsResult> {
  const params: Record<string, string> = {
    To: input.to,
    From: input.from,
    Body: input.body,
  };
  if (input.statusCallback) params.StatusCallback = input.statusCallback;

  let response: Response;
  try {
    response = await rest(config, "POST", "/Messages.json", params);
  } catch (error) {
    return { kind: "unknown", error: error instanceof Error ? error.message : String(error) };
  }

  const body = (await response.json().catch(() => null)) as {
    sid?: string;
    status?: string;
    code?: number;
    message?: string;
  } | null;

  if (response.ok && body?.sid) {
    return { kind: "sent", sid: body.sid, status: body.status ?? "queued" };
  }
  if (response.status >= 500) {
    return { kind: "unknown", error: `HTTP ${response.status}` };
  }
  logger.warn("twilio.sms_refused", { status: response.status, code: body?.code ?? null });
  return {
    kind: "refused",
    status: response.status,
    code: body?.code ?? null,
    message: body?.message ?? `HTTP ${response.status}`,
  };
}

/** The recording's audio. Twilio serves WAV when `.wav` is appended. */
export async function downloadRecording(config: TwilioConfig, recordingUrl: string): Promise<Buffer> {
  const url = new URL(recordingUrl.endsWith(".wav") ? recordingUrl : `${recordingUrl}.wav`);
  if (url.hostname !== "api.twilio.com") {
    // The URL arrives in a webhook. Signed, but credentials go nowhere else.
    throw new Error("Refusing to send Twilio credentials to another host");
  }
  const response = await fetch(url, {
    headers: { authorization: authHeader(config) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Recording download failed: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Deletes a recording once it has been transcribed. The transcript is what
 * the business needs; keeping the audio at the provider is a liability.
 */
export async function deleteRecording(config: TwilioConfig, recordingSid: string): Promise<boolean> {
  if (!/^RE[0-9a-f]{32}$/i.test(recordingSid)) return false;
  const response = await rest(config, "DELETE", `/Recordings/${recordingSid}.json`).catch(() => null);
  return response?.status === 204 || response?.status === 404;
}

export type ProvisionedNumber = { e164: string; sid: string };

/**
 * Buys a number and points its webhooks at us.
 *
 * Norwegian numbers need a regulatory bundle at Twilio (an address and a
 * business identity). Pass it when the account has one; without it Twilio
 * refuses and the error is shown to the owner as it is.
 */
export async function provisionNumber(
  config: TwilioConfig,
  input: {
    country: string;
    voiceUrl: string;
    smsUrl: string;
    statusCallback?: string;
    bundleSid?: string;
    addressSid?: string;
    friendlyName: string;
  }
): Promise<ProvisionedNumber> {
  let candidate: string | null = null;
  for (const type of ["Mobile", "Local"]) {
    const response = await rest(config, "GET", `/AvailablePhoneNumbers/${input.country}/${type}.json`, {
      SmsEnabled: "true",
      VoiceEnabled: "true",
      PageSize: "1",
    });
    if (!response.ok) continue;
    const body = (await response.json()) as { available_phone_numbers?: { phone_number: string }[] };
    candidate = body.available_phone_numbers?.[0]?.phone_number ?? null;
    if (candidate) break;
  }
  if (!candidate) {
    throw new Error(`Twilio has no ${input.country} numbers with voice and SMS available`);
  }

  const params: Record<string, string> = {
    PhoneNumber: candidate,
    FriendlyName: input.friendlyName.slice(0, 64),
    VoiceUrl: input.voiceUrl,
    VoiceMethod: "POST",
    SmsUrl: input.smsUrl,
    SmsMethod: "POST",
  };
  if (input.statusCallback) params.StatusCallback = input.statusCallback;
  if (input.bundleSid) params.BundleSid = input.bundleSid;
  if (input.addressSid) params.AddressSid = input.addressSid;

  const response = await rest(config, "POST", "/IncomingPhoneNumbers.json", params);
  const body = (await response.json().catch(() => null)) as {
    sid?: string;
    phone_number?: string;
    message?: string;
  } | null;
  if (!response.ok || !body?.sid || !body.phone_number) {
    throw new Error(body?.message ?? `Twilio refused the number: HTTP ${response.status}`);
  }
  return { e164: body.phone_number, sid: body.sid };
}
