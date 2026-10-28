import { appOrigin } from "@/agent/lib/email-template";
import { logger } from "@/lib/logger";

import { readTwilioConfig, readTwilioForm, verifyTwilioSignature, type TwilioConfig } from "./twilio";

export type VerifiedTwilioRequest = {
  config: TwilioConfig;
  params: Record<string, string>;
};

/**
 * Reads and verifies a Twilio webhook. Returns null for anything unsigned or
 * signed with another account's token — the route answers 403 and does
 * nothing else.
 */
export async function verifiedTwilioRequest(request: Request): Promise<VerifiedTwilioRequest | null> {
  const config = readTwilioConfig();
  if (!config) {
    logger.error("telephony.twilio_unconfigured", {});
    return null;
  }
  const params = await readTwilioForm(request);
  const url = new URL(request.url);
  const urls = [url.toString()];
  const origin = appOrigin();
  if (origin) urls.push(`${origin}${url.pathname}${url.search}`);

  const ok = verifyTwilioSignature({
    authToken: config.authToken,
    signature: request.headers.get("x-twilio-signature"),
    urls,
    params,
  });
  if (!ok) {
    logger.warn("telephony.bad_signature", { path: url.pathname });
    return null;
  }
  return { config, params };
}

/** The public URL Twilio should call back on. */
export function callbackUrl(path: string, query: Record<string, string> = {}): string {
  const url = new URL(path, appOrigin() ?? "http://localhost:3000");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

export function forbidden(): Response {
  return new Response("Forbidden", { status: 403 });
}
