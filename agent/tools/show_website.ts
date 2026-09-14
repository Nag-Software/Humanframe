import { defineTool } from "eve/tools";
import { z } from "zod";

/** A link card with title, domain and description. */
export default defineTool({
  description:
    "Show a website as a link card with title, domain and description. " +
    "Use it when you point the user at one specific page.",
  inputSchema: z.object({
    url: z.url().describe("Full URL including https://"),
    title: z.string(),
    description: z.string().describe("One or two sentences about the page"),
    preview: z
      .boolean()
      .optional()
      .describe("True to render the page in an embedded preview"),
  }),
  async execute(input) {
    return input;
  },
});
