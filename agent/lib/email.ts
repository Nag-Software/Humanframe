/**
 * Resend, and what it does and does not promise.
 *
 * Idempotency (verified against Resend's documentation, September 2026):
 *  - the header is `Idempotency-Key`, up to 256 characters;
 *  - keys expire after **24 hours**;
 *  - the same key with the same payload returns the original response and does
 *    not send again;
 *  - the same key with a *different* payload is refused with `409
 *    invalid_idempotent_request`.
 *
 * So within 24 hours a retry is deduplicated by the provider, and our backoff
 * schedule stays inside that window deliberately. Beyond it the key is gone and
 * a retry would be a second email — which is why an attempt cap exists, and why
 * nothing here claims exactly-once. What is claimed: at-most-once inside the
 * provider's 24-hour window, at-least-once overall, and a timeout treated as
 * *unknown* rather than as failure.
 */

export type EmailPayload = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type SendResult =
  /** Resend accepted it. */
  | { kind: "sent"; providerMessageId: string | null }
  /** Resend recognised the key and did not send again. */
  | { kind: "duplicate"; providerMessageId: string | null }
  /** It definitely did not go: bad request, rejected address, bad key. */
  | { kind: "refused"; status: number; error: unknown }
  /** Try later: rate limited or provider-side failure. */
  | { kind: "retry"; status: number; error: unknown }
  /** Unknown: a timeout or a reset after the request left this process. */
  | { kind: "unknown"; error: unknown };

export type EmailConfig = {
  apiKey: string;
  from: string;
  /** When false, nothing is sent. Preview defaults to false. */
  enabled: boolean;
  /** When set, only these addresses may be written to. */
  allowlist: string[] | null;
};

export function readEmailConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): EmailConfig | null {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return null;
  }
  const allowlist = env.NOTIFICATIONS_ALLOWLIST?.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  return {
    apiKey,
    from: env.NOTIFICATIONS_FROM ?? "Maya <maya@humanframe.app>",
    // Opt-in per environment, so a preview deployment cannot email real users
    // by inheriting production's configuration.
    enabled: env.NOTIFICATIONS_ENABLED === "true",
    allowlist: allowlist && allowlist.length > 0 ? allowlist : null,
  };
}

export function isAllowedRecipient(config: EmailConfig, address: string): boolean {
  if (!config.allowlist) {
    return true;
  }
  return config.allowlist.includes(address.trim().toLowerCase());
}

export async function sendEmail(input: {
  config: EmailConfig;
  payload: EmailPayload;
  /** Stable for the life of the notification: same job, same key, every retry. */
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<SendResult> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.config.apiKey}`,
        "content-type": "application/json",
        // Resend's recommended shape is <event-type>/<entity-id>.
        "Idempotency-Key": input.idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({
        from: input.config.from,
        to: [input.payload.to],
        subject: input.payload.subject,
        html: input.payload.html,
        text: input.payload.text,
      }),
      signal: input.signal,
    });

    if (response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { id?: string }
        | null;
      return { kind: "sent", providerMessageId: body?.id ?? null };
    }

    const error = await response.json().catch(() => ({ status: response.status }));

    // The key was reused with a different payload. That is a bug on our side,
    // not a transient failure: the job's content is supposed to be stable.
    if (response.status === 409) {
      return { kind: "refused", status: 409, error };
    }
    if (response.status === 429 || response.status >= 500) {
      return { kind: "retry", status: response.status, error };
    }
    return { kind: "refused", status: response.status, error };
  } catch (error) {
    // A timeout or a reset proves nothing: Resend may already have accepted
    // it. Treated as unknown, and the idempotency key covers the retry.
    return { kind: "unknown", error };
  }
}
