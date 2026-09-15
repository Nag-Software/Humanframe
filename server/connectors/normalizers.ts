import { z } from "zod";

/**
 * Versioned result contracts.
 *
 * A provider result is untrusted input. It is parsed into one of these shapes
 * server-side before anything renders it, so the UI never reasons about a raw
 * Composio payload and a provider that changes its output shape produces a
 * validation failure rather than a broken or misleading card.
 *
 * Versions are additive and kept. A result stored under `email.list.v1` must
 * still render after a deploy that introduces v2.
 */

export const emailListV1 = z.object({
  version: z.literal("email.list.v1"),
  messages: z.array(
    z.object({
      id: z.string(),
      threadId: z.string().nullable(),
      from: z.string(),
      to: z.array(z.string()),
      subject: z.string(),
      snippet: z.string(),
      date: z.string().nullable(),
      unread: z.boolean(),
    })
  ),
  truncated: z.boolean(),
});

export const emailThreadV1 = z.object({
  version: z.literal("email.thread.v1"),
  threadId: z.string(),
  subject: z.string(),
  messages: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.array(z.string()),
      date: z.string().nullable(),
      /** Plain text only. HTML is stripped here, not in the browser. */
      body: z.string(),
      /** Surfaced so the UI can warn rather than silently hide them. */
      linkCount: z.number(),
    })
  ),
});

export const emailSendV1 = z.object({
  version: z.literal("email.send.v1"),
  providerMessageId: z.string().nullable(),
  providerThreadId: z.string().nullable(),
  status: z.enum(["sent", "unknown"]),
});

export type EmailListV1 = z.infer<typeof emailListV1>;
export type EmailThreadV1 = z.infer<typeof emailThreadV1>;
export type EmailSendV1 = z.infer<typeof emailSendV1>;

const MAX_SNIPPET = 400;
const MAX_BODY = 20_000;
const MAX_MESSAGES = 25;

/**
 * Strips markup to text.
 *
 * Email HTML is hostile by default: scripts, tracking pixels, and link text
 * that disagrees with its href. None of it is needed to understand a message,
 * so none of it survives. Rendering sanitized HTML would mean trusting a
 * sanitizer against an attacker; rendering text does not.
 */
export function toPlainText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function countLinks(input: string): number {
  return (input.match(/https?:\/\//gi) ?? []).length;
}

type Normalizer = (raw: unknown) => unknown;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pick(record: unknown, ...keys: string[]): unknown {
  if (typeof record !== "object" || record === null) return undefined;
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

function addresses(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => str(v)).filter(Boolean);
  const single = str(value);
  return single ? single.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Gmail and Outlook differ in shape but not in meaning, so both collapse into
 * the same contract and the same components render them.
 */
const NORMALIZERS: Record<string, Normalizer> = {
  "email.list": (raw) => {
    const container = pick(raw, "data", "response_data") ?? raw;
    const items = asArray(
      pick(container, "messages", "value", "items", "emails") ?? container
    ).slice(0, MAX_MESSAGES);

    return emailListV1.parse({
      version: "email.list.v1",
      messages: items.map((item) => ({
        id: str(pick(item, "id", "messageId", "message_id"), "unknown"),
        threadId: (pick(item, "threadId", "thread_id", "conversationId") ?? null) as
          | string
          | null,
        from: str(
          pick(
            pick(pick(item, "from"), "emailAddress") ?? pick(item, "from"),
            "address",
            "email",
            "name"
          ) ?? pick(item, "from", "sender"),
          "unknown"
        ),
        to: addresses(pick(item, "to", "toRecipients", "to_addresses")),
        subject: str(pick(item, "subject"), "(no subject)").slice(0, 500),
        snippet: toPlainText(
          str(pick(item, "snippet", "bodyPreview", "preview"))
        ).slice(0, MAX_SNIPPET),
        date: (pick(item, "date", "receivedDateTime", "internalDate") ?? null) as
          | string
          | null,
        unread: pick(item, "isRead") === false || pick(item, "unread") === true,
      })),
      truncated: asArray(pick(container, "messages", "value", "items") ?? container).length >
        MAX_MESSAGES,
    });
  },

  "email.thread": (raw) => {
    const container = pick(raw, "data", "response_data") ?? raw;
    const items = asArray(
      pick(container, "messages", "value", "items") ?? [container]
    ).slice(0, MAX_MESSAGES);

    const first = items[0];
    return emailThreadV1.parse({
      version: "email.thread.v1",
      threadId: str(
        pick(container, "threadId", "thread_id", "conversationId") ??
          pick(first, "threadId", "conversationId"),
        "unknown"
      ),
      subject: str(pick(first, "subject"), "(no subject)").slice(0, 500),
      messages: items.map((item) => {
        const bodyRaw = str(
          pick(pick(item, "body"), "content") ??
            pick(item, "body", "messageText", "text", "snippet")
        );
        const body = toPlainText(bodyRaw).slice(0, MAX_BODY);
        return {
          id: str(pick(item, "id", "messageId"), "unknown"),
          from: str(
            pick(
              pick(pick(item, "from"), "emailAddress") ?? pick(item, "from"),
              "address",
              "email"
            ) ?? pick(item, "from", "sender"),
            "unknown"
          ),
          to: addresses(pick(item, "to", "toRecipients")),
          date: (pick(item, "date", "receivedDateTime") ?? null) as string | null,
          body,
          linkCount: countLinks(bodyRaw),
        };
      }),
    });
  },

  "email.send": (raw) => {
    const container = pick(raw, "data", "response_data") ?? raw;
    return emailSendV1.parse({
      version: "email.send.v1",
      providerMessageId: (pick(container, "id", "messageId", "message_id") ?? null) as
        | string
        | null,
      providerThreadId: (pick(container, "threadId", "thread_id") ?? null) as
        | string
        | null,
      status: "sent",
    });
  },
};

export function hasNormalizer(name: string): boolean {
  return Object.hasOwn(NORMALIZERS, name);
}

/**
 * Normalises, or refuses.
 *
 * A provider result that will not parse is never handed onward as raw JSON:
 * for a read that means a limited fallback card, and for a side effect it
 * means the action is blocked, because an approval preview that cannot be
 * shown completely is not an approval.
 */
export function normalize(
  name: string,
  raw: unknown
): { ok: true; value: unknown } | { ok: false; error: string } {
  const normalizer = NORMALIZERS[name];
  if (!normalizer) {
    return { ok: false, error: `Unknown normalizer: ${name}` };
  }
  try {
    return { ok: true, value: normalizer(raw) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
