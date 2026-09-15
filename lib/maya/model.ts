import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import { serverEnv } from "@/lib/env";

/**
 * Phase 1 still calls OpenAI directly, because the provider-executed web
 * search tool needs the OpenAI provider. Model routing moves to eve and the
 * AI Gateway (Vercel OIDC in preview/production) in phase 2, at which point
 * this module goes away.
 */
export function mayaModel(): LanguageModel {
  const env = serverEnv();
  if (!env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is missing. Add it to .env.local in the project root."
    );
  }

  return openai.responses(env.MAYA_LEGACY_MODEL);
}

/**
 * Web search runs on OpenAI's side. Results come back as source parts and are
 * rendered by the thread.
 */
export function webSearchTool() {
  return openai.tools.webSearch();
}
