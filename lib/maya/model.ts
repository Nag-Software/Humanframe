import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/** Maya kjører på OpenAI. Overstyr modellnavnet med MAYA_MODEL. */
export function mayaModel(): LanguageModel {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY mangler i serverprosessen. Legg den i .env.local i " +
        "prosjektroten (next dev laster den automatisk)."
    );
  }

  return openai.responses(process.env.MAYA_MODEL ?? "gpt-5.2");
}

/**
 * Websøk kjøres av OpenAI selv. Treffene kommer tilbake som source-parts
 * og rendres av tråden.
 */
export function webSearchTool() {
  return openai.tools.webSearch();
}
