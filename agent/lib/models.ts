import { openai } from "@ai-sdk/openai";
import type { EmbeddingModel, LanguageModel } from "ai";

/**
 * Model routing for the memory pipeline.
 *
 * The route is configured, never inferred from the shape of a model id. Each
 * role — Maya, extraction, embeddings — is chosen independently, so extraction
 * can run on a cheaper model than the one that talks to the user, and a broken
 * configuration fails at startup instead of halfway through a turn.
 */
export type ModelRoute = "gateway" | "openai";

const ROUTES: readonly ModelRoute[] = ["gateway", "openai"];

export const EMBEDDING_DIMENSIONS = 1536;

function readRoute(variable: string, fallback: ModelRoute): ModelRoute {
  const value = process.env[variable]?.trim();
  if (!value) {
    return fallback;
  }
  if (!ROUTES.includes(value as ModelRoute)) {
    throw new Error(
      `${variable} must be one of ${ROUTES.join(", ")}; got "${value}"`
    );
  }
  return value as ModelRoute;
}

function assertCredentials(route: ModelRoute, variable: string): void {
  if (route === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error(
      `${variable}=openai requires OPENAI_API_KEY in the runtime environment`
    );
  }
  if (
    route === "gateway" &&
    !process.env.AI_GATEWAY_API_KEY &&
    !process.env.VERCEL_OIDC_TOKEN
  ) {
    throw new Error(
      `${variable}=gateway requires AI_GATEWAY_API_KEY or Vercel OIDC`
    );
  }
}

function readModelId(variable: string, fallback: string): string {
  const value = process.env[variable]?.trim();
  if (value === undefined || value === "") {
    return fallback;
  }
  return value;
}

/** The model that turns a finished exchange into memory candidates. */
export function memoryModel(): LanguageModel {
  const route = readRoute("MEMORY_MODEL_PROVIDER", "gateway");
  assertCredentials(route, "MEMORY_MODEL_PROVIDER");

  const id = readModelId(
    "MEMORY_MODEL",
    route === "gateway" ? "openai/gpt-5-mini" : "gpt-5-mini"
  );

  return route === "gateway" ? id : openai(id);
}

/**
 * The embedding model. `openai/text-embedding-3-small` is in the AI Gateway
 * catalogue, so the gateway is the default here too and OPENAI_API_KEY is only
 * needed when the route is explicitly set to `openai`.
 */
export function embeddingModel(): EmbeddingModel {
  const route = readRoute("EMBEDDING_PROVIDER", "gateway");
  assertCredentials(route, "EMBEDDING_PROVIDER");

  const id = readModelId(
    "EMBEDDING_MODEL",
    route === "gateway"
      ? "openai/text-embedding-3-small"
      : "text-embedding-3-small"
  );

  return route === "gateway" ? id : openai.textEmbeddingModel(id);
}

/** Normalises an entity name the same way the database's generated column does. */
export function normalizeEntityName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}
