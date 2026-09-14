import { readFileSync } from "node:fs";

import { Client, defaultMessageReducer } from "eve/client";
import type { EveMessage, EveMessageData } from "eve/client";

import { toThreadMessage } from "../lib/maya/eve-message-adapter.ts";

export type ThreadMessage = ReturnType<typeof toThreadMessage>;
export type ThreadPart = Exclude<ThreadMessage["content"], string>[number];

export function loadEnv(path = ".env.local"): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) {
      // The Vercel CLI writes quoted values.
      env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return { ...env, ...process.env } as Record<string, string>;
}

/** A signed-in browser, minus the browser: a real Supabase session cookie. */
export async function createTestUser(env: Record<string, string>) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const email = `bridge-test-${Date.now()}@humanframe.test`;
  const password = "Test-1234-aaaa";

  const admin = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
  };

  const created = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ email, password, email_confirm: true }),
  }).then((response) => response.json());

  const session = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  }).then((response) => response.json());

  const ref = new URL(url).hostname.split(".")[0];
  const value = `base64-${Buffer.from(JSON.stringify(session), "utf8").toString("base64url")}`;

  return {
    userId: created.id as string,
    cookie: `sb-${ref}-auth-token=${value}`,
    async remove() {
      await fetch(`${url}/auth/v1/admin/users/${created.id}`, {
        method: "DELETE",
        headers: admin,
      });
    },
  };
}

/**
 * Drives one conversation the way the browser does: the app route starts the
 * session, and the stream is projected with eve's own reducer and then through
 * the adapter the Maya thread renders with. Assertions therefore see exactly
 * what assistant-ui would.
 */
export class BridgeSession {
  #client: Client;
  #reducer = defaultMessageReducer();
  #data: EveMessageData;
  #parksSeen = 0;
  /** Set when a turn fails, so an empty projection reports the real cause. */
  lastFailure: string | null = null;
  sessionId!: string;
  threadId!: string;

  readonly #appUrl: string;
  readonly #cookie: string;

  // Node's type stripping has no parameter properties, so the fields are
  // declared explicitly.
  constructor(appUrl: string, cookie: string) {
    this.#appUrl = appUrl;
    this.#cookie = cookie;
    this.#client = new Client({
      host: appUrl,
      headers: { cookie },
      redirect: "manual",
    });
    this.#data = this.#reducer.initial();
  }

  /** Starts the conversation through the app's own route, not the eve API. */
  async start(message: string): Promise<void> {
    const response = await fetch(`${this.#appUrl}/api/assistants/maya/session`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.#cookie },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      throw new Error(`session start failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      threadId: string;
      sessionId: string;
    };
    this.threadId = body.threadId;
    this.sessionId = body.sessionId;
  }

  async send(message: string): Promise<void> {
    await this.#client.sessions
      .attach(this.sessionId)
      .send(message, { turnPolicy: "queue" });
  }

  async respond(requestId: string, optionId: string): Promise<void> {
    await this.#client.sessions
      .attach(this.sessionId)
      .respond([{ requestId, optionId }]);
  }

  /**
   * Replays the durable stream from the start and stops at the park that
   * follows the work just submitted. Replaying is what a page reload does, so
   * the projection under test is the same one a returning user would see; the
   * park counter is what keeps an earlier pause from ending the read early.
   */
  async settle(timeoutMs = 120_000): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    this.#data = this.#reducer.initial();
    const session = this.#client.sessions.attach(this.sessionId, {
      streamIndex: 0,
    });

    let parks = 0;
    try {
      for await (const event of session.stream({ signal: controller.signal })) {
        this.#data = this.#reducer.reduce(this.#data, event);

        if (event.type === "turn.failed" || event.type === "session.failed") {
          this.lastFailure = `${event.data.code}: ${event.data.message}`;
        }
        if (event.type === "session.failed") {
          break;
        }
        if (event.type === "session.waiting") {
          parks += 1;
          if (parks > this.#parksSeen) {
            this.#parksSeen = parks;
            break;
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  get messages(): readonly EveMessage[] {
    return this.#data.messages;
  }

  /** What assistant-ui would render. */
  get threadMessages(): ThreadMessage[] {
    return this.#data.messages.map(toThreadMessage);
  }

  get lastAssistantMessage(): ThreadMessage | undefined {
    return [...this.threadMessages]
      .reverse()
      .find((message) => message.role === "assistant");
  }

  get assistantParts(): ThreadPart[] {
    return this.threadMessages
      .filter((message) => message.role === "assistant")
      .flatMap((message) =>
        typeof message.content === "string" ? [] : [...message.content]
      );
  }

  pendingApprovals(): { requestId: string; toolName: string }[] {
    return this.assistantParts.flatMap((part) => {
      if (part.type !== "tool-call" || !part.approval) return [];
      if (part.approval.approved !== undefined) return [];
      return [{ requestId: part.approval.id, toolName: part.toolName }];
    });
  }
}

export function partsOf(message: ThreadMessage | undefined): ThreadPart[] {
  if (!message || typeof message.content === "string") {
    return [];
  }
  return [...message.content];
}

export function visibleText(parts: ThreadPart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n")
    .trim();
}

export function toolCalls(parts: ThreadPart[]): { toolName: string }[] {
  return parts.flatMap((part) =>
    part.type === "tool-call" ? [{ toolName: part.toolName }] : []
  );
}
