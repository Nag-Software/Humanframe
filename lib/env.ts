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
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  APP_URL: z.url().default("http://localhost:3000"),
  // The phase 1 AI SDK route's model. Maya's own model belongs to eve and
  // lives in agent/agent.ts, not here.
  MAYA_MODEL: z.string().default("gpt-5.2"),
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
});

export const publicEnv = publicSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_MAYA_RUNTIME: process.env.NEXT_PUBLIC_MAYA_RUNTIME,
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
