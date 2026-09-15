import { z } from "zod";

/**
 * Environment validation. Public variables are inlined by Next at build time,
 * so they must be referenced statically. Server variables are parsed lazily so
 * that importing this module from a client component stays safe.
 */

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  /**
   * Which runtime backs the Maya chat. `ai-sdk` is the phase 1 path that talks
   * to /api/assistants/maya/chat; `eve` is the durable agent runtime.
   */
  NEXT_PUBLIC_MAYA_RUNTIME: z.enum(["ai-sdk", "eve"]).default("ai-sdk"),
  /**
   * Whether the Call button is offered at all. Off by default, and only ever
   * an affordance: the server checks `CALL_ENABLED` before it will start one,
   * so turning this on alone cannot place a call.
   */
  NEXT_PUBLIC_CALL_ENABLED: z.enum(["true", "false"]).default("false"),
  /** Whether the Connections settings section is offered. */
  NEXT_PUBLIC_CONNECTORS_ENABLED: z.enum(["true", "false"]).default("false"),
  /**
   * Whether the FaceTime prototype button is offered. Off by default, and
   * only an affordance: the server checks `FACETIME_PROTOTYPE_ENABLED`
   * before it will start one.
   */
  NEXT_PUBLIC_FACETIME_PROTOTYPE: z.enum(["true", "false"]).default("false"),
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  APP_URL: z.url().default("http://localhost:3000"),
  // The phase 1 AI SDK route's model: a bare OpenAI id for the Responses API.
  // Maya's own model belongs to eve and lives in agent/agent.ts, never here —
  // the name says "legacy" so the two can never be confused again.
  MAYA_LEGACY_MODEL: z.string().default("gpt-5.2"),
  // Model access: AI Gateway via Vercel OIDC in preview/production, with an
  // optional local key fallback. OPENAI_API_KEY stays for the OpenAI-specific
  // paths (Responses API today, GPT-Live later).
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  // The memory pipeline runs on its own models: extraction can be cheaper than
  // Maya, and embeddings are a different model entirely. The route is
  // configured, never inferred from the model id.
  MEMORY_MODEL: z.string().default("openai/gpt-5-mini"),
  MEMORY_MODEL_PROVIDER: z.enum(["gateway", "openai"]).default("gateway"),
  EMBEDDING_MODEL: z.string().default("openai/text-embedding-3-small"),
  EMBEDDING_PROVIDER: z.enum(["gateway", "openai"]).default("gateway"),
  // Email notification. Server-only, and off unless an environment turns it on
  // explicitly: a preview deployment must not inherit production's ability to
  // email real people.
  RESEND_API_KEY: z.string().min(1).optional(),
  NOTIFICATIONS_ENABLED: z.enum(["true", "false"]).default("false"),
  NOTIFICATIONS_FROM: z.string().default("Maya <maya@humanframe.app>"),
  // Comma-separated. When set, no other address can be written to.
  NOTIFICATIONS_ALLOWLIST: z.string().optional(),
  // Call. Off unless an environment turns it on, the same discipline email
  // notification follows: a deployment must never inherit the ability to spend
  // on voice minutes just by existing.
  CALL_ENABLED: z.enum(["true", "false"]).default("false"),
  // The Realtime model and voice. Verified live before use; see
  // server/call/openai-live.ts.
  CALL_MODEL: z.string().default("gpt-live-1"),
  CALL_VOICE: z.string().default("marin"),
  // Server-enforced ceilings. See server/call/limits.ts for what each one
  // actually bounds.
  CALL_MAX_PER_DAY: z.coerce.number().int().positive().default(20),
  CALL_MAX_CONCURRENT: z.coerce.number().int().positive().default(1),
  CALL_MAX_MINUTES: z.coerce.number().int().positive().default(15),
  // Email connectors (Gmail, Outlook) brokered by Composio. Server-only: the
  // key can mint authorization links and run tools against real mailboxes.
  COMPOSIO_API_KEY: z.string().min(1).optional(),
  CONNECTORS_ENABLED: z.enum(["true", "false"]).default("false"),
  // Auth configs pinned to least-privilege scopes. Named explicitly because
  // Composio's defaults ask for far more than the four tools we expose — see
  // server/connectors/composio.ts.
  COMPOSIO_GMAIL_AUTH_CONFIG_ID: z.string().optional(),
  COMPOSIO_OUTLOOK_AUTH_CONFIG_ID: z.string().optional(),
  // FaceTime prototype. Off unless an environment turns it on. The key never
  // reaches the browser. A PAL id is created once by the setup script; this
  // route will not mint faces or clone a voice.
  FACETIME_PROTOTYPE_ENABLED: z.enum(["true", "false"]).default("false"),
  TAVUS_API_KEY: z.string().min(1).optional(),
  TAVUS_PAL_ID: z.string().min(1).optional(),
});

export const publicEnv = publicSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_MAYA_RUNTIME: process.env.NEXT_PUBLIC_MAYA_RUNTIME,
  NEXT_PUBLIC_CALL_ENABLED: process.env.NEXT_PUBLIC_CALL_ENABLED,
  NEXT_PUBLIC_CONNECTORS_ENABLED: process.env.NEXT_PUBLIC_CONNECTORS_ENABLED,
  NEXT_PUBLIC_FACETIME_PROTOTYPE: process.env.NEXT_PUBLIC_FACETIME_PROTOTYPE,
});

type ServerEnv = z.infer<typeof serverSchema> & z.infer<typeof publicSchema>;

let cachedServerEnv: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() was called in the browser");
  }
  if (cachedServerEnv) {
    return cachedServerEnv;
  }

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(
      `Invalid server environment. Check .env.local: ${missing}`
    );
  }

  cachedServerEnv = { ...publicEnv, ...parsed.data };
  return cachedServerEnv;
}
