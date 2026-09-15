import { openai } from "@ai-sdk/openai";
import type { EmbeddingModel, LanguageModel } from "ai";

/**
 * Models for the memory pipeline, kept separate from Maya's own model so
 * extraction can run on something cheaper than the model that talks to the
 * user.
 *
 * An id containing "/" is an AI Gateway id and is passed through as a string,
 * which routes through the gateway exactly like Maya does. A bare id uses the
 * OpenAI provider directly with OPENAI_API_KEY — embeddings in particular are
 * not worth blocking on gateway quota.
 */
export function memoryModel(): LanguageModel {
  const id = process.env.MEMORY_MODEL ?? "openai/gpt-5-mini";
  return id.includes("/") ? id : openai(id);
}

export function embeddingModel(): EmbeddingModel {
  const id = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
  return id.includes("/") ? id : openai.textEmbeddingModel(id);
}

/** Dimension of the embedding column; a model change needs a migration. */
export const EMBEDDING_DIMENSIONS = 1536;
