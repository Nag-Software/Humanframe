import { z } from "zod";

import { createCommitment } from "@/agent/lib/commitments";
import { INTERNAL_TIMER_PATH } from "@/agent/lib/internal-routes";
import { readInternalToken } from "@/agent/lib/internal-auth";
import { searchMemories } from "@/agent/lib/memory-store";
import { logger } from "@/lib/logger";
import type { CallBinding } from "@/server/call/binding";

/**
 * The tools Maya can use while speaking.
 *
 * Declared once, provider-neutrally: name, description and a JSON Schema. Each
 * adapter translates this list into its own wire format, and every adapter
 * calls `executeCallTool` to run one. Nothing here knows what OpenAI's event
 * types are called.
 *
 * The first version is deliberately read-mostly. `schedule_followup` is the one
 * writing tool, and it creates the same commitment row, on the same durable
 * timer, as the chat path — there is no second reminder system. Anything
 * risky stays in chat, where approval already exists.
 */
export type CallToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export const CALL_TOOLS: readonly CallToolDefinition[] = [
  {
    name: "recall",
    description:
      "Search your own memory of this user for something you were not already " +
      "given. Use it when the answer depends on a detail you cannot see.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you are trying to remember, in natural language",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_commitments",
    description:
      "List what you have promised to come back to: what is scheduled, and " +
      "what is overdue.",
    parameters: {
      type: "object",
      properties: {
        includeFinished: {
          type: "boolean",
          description: "Include commitments that are done or cancelled",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_followup",
    description:
      "Promise to follow up on something at a specific time. The deadline must " +
      "be an absolute instant: resolve what the user said against their " +
      "timezone, then say the resolved day and time back to them out loud.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "What you are coming back to, in the user's own words",
        },
        detail: {
          type: "string",
          description: "What you will need to know when this comes up again",
        },
        dueAt: {
          type: "string",
          description: "When it is due, ISO 8601 with an explicit offset",
        },
        kind: {
          type: "string",
          enum: ["follow_up", "remind", "deliver"],
          description:
            "follow_up: you chase it. remind: you tell them. deliver: you produce something.",
        },
      },
      required: ["title", "dueAt", "kind"],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(CALL_TOOLS.map((tool) => tool.name));

export function isCallTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

const recallInput = z.object({ query: z.string().min(2).max(400) });
const listInput = z.object({ includeFinished: z.boolean().nullish() });
const scheduleInput = z.object({
  title: z.string().min(3).max(200),
  detail: z.string().max(2000).nullish(),
  dueAt: z.string().min(4),
  kind: z.enum(["follow_up", "remind", "deliver"]),
});

export type CallToolResult = {
  ok: boolean;
  output: unknown;
};

/**
 * Runs one tool for a call.
 *
 * Every scope value comes from `binding` — the row written when the call was
 * authorised — and never from `args`. The model chooses *what* to do; it has no
 * say in *whose* data it happens to.
 *
 * `callId` is the provider's id for this tool call. It becomes the commitment's
 * dedupe key, so a call the provider retries, or a browser that relays the same
 * call twice, claims the same row instead of making a second promise.
 */
export async function executeCallTool(
  binding: CallBinding,
  name: string,
  args: unknown,
  callId: string
): Promise<CallToolResult> {
  if (!isCallTool(name)) {
    return { ok: false, output: { error: `Unknown tool: ${name}` } };
  }

  const scope = {
    client: binding.client,
    workspaceId: binding.workspaceId,
    assistantId: binding.assistantId,
    userId: binding.userId,
  };

  try {
    if (name === "recall") {
      const input = recallInput.parse(args);
      const memories = await searchMemories(scope, {
        query: input.query,
        limit: 5,
      });
      return {
        ok: true,
        output: {
          memories: memories.map((memory) => ({
            content: memory.content,
            kind: memory.kind,
            occurredAt: memory.occurred_at,
          })),
        },
      };
    }

    if (name === "list_commitments") {
      const input = listInput.parse(args ?? {});
      let query = binding.client
        .from("commitments")
        .select("id, title, detail, due_at, due_timezone, status, kind")
        .eq("workspace_id", binding.workspaceId)
        .eq("assistant_id", binding.assistantId)
        .order("due_at", { ascending: true })
        .limit(20);

      if (!input.includeFinished) {
        query = query.not("status", "in", '("done","cancelled")');
      }

      const { data } = await query;
      return { ok: true, output: { commitments: data ?? [] } };
    }

    const input = scheduleInput.parse(args);
    const dueAt = new Date(input.dueAt);
    if (Number.isNaN(dueAt.getTime())) {
      return {
        ok: false,
        output: { error: `"${input.dueAt}" is not a date I can use.` },
      };
    }

    const commitment = await createCommitment(scope, {
      threadId: binding.threadId,
      title: input.title,
      detail: input.detail ?? null,
      dueAt: dueAt.toISOString(),
      dueTimezone: timezoneOf(input.dueAt),
      kind: input.kind,
      userId: binding.userId,
      sourceThreadId: binding.threadId,
      dedupeKey: `call:${binding.callSessionId}:${callId}`,
    });

    await startTimer(commitment.id, commitment.due_at);

    return {
      ok: true,
      output: {
        scheduled: true,
        commitmentId: commitment.id,
        dueAt: commitment.due_at,
      },
    };
  } catch (error) {
    logger.error("call.tool_failed", {
      callSessionId: binding.callSessionId,
      tool: name,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      output: { error: "That did not work. Tell the user, briefly." },
    };
  }
}

/**
 * Starts the same detached timer chat uses — by asking the eve runtime to.
 *
 * A durable workflow can only be started from inside eve's own bundle: the
 * `workflow` module is supplied by eve's builder and does not exist in the
 * Next.js build. So this posts to Humanframe's internal channel with a fresh
 * Vercel OIDC token, and eve starts the workflow there.
 *
 * A failure is logged and swallowed. The promise to the user is the committed
 * row, and the daily heartbeat sweeps up any commitment whose clock never
 * started — which can mean up to about a day's delay, and is why the immediate
 * start exists at all.
 */
async function startTimer(commitmentId: string, dueAt: string): Promise<void> {
  const token = readInternalToken();
  const origin = internalOrigin();

  if (!token || !origin) {
    logger.error("call.timer_start_unavailable", {
      commitmentId,
      dueAt,
      reason: token ? "no_origin" : "no_oidc_token",
      note: "the heartbeat will pick this commitment up when it falls due",
    });
    return;
  }

  try {
    const response = await fetch(`${origin}${INTERNAL_TIMER_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-humanframe-internal": "delivery",
      },
      body: JSON.stringify({ commitmentId }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`internal timer route answered ${response.status}`);
    }
  } catch (error) {
    logger.error("call.timer_start_failed", {
      commitmentId,
      message: error instanceof Error ? error.message : String(error),
      note: "the heartbeat will pick this commitment up when it falls due",
    });
  }
}

/** This deployment's own origin, for calling ourselves. */
function internalOrigin(): string | null {
  const configured = process.env.APP_URL?.trim();
  if (configured && !/localhost|127\.0\.0\.1/.test(configured)) {
    return configured.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return configured ? configured.replace(/\/$/, "") : null;
}

function timezoneOf(iso: string): string {
  const match = /([+-]\d{2}:\d{2}|Z)$/.exec(iso.trim());
  if (!match) {
    return "UTC";
  }
  return match[1] === "Z" ? "UTC" : `UTC${match[1]}`;
}
