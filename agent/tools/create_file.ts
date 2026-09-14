import { defineTool } from "eve/tools";
import { z } from "zod";

/** Produces a downloadable file rendered as a compact file card in the chat. */
export default defineTool({
  description:
    "Create a downloadable file for the user (a note, a table, code, JSON). " +
    "Use it when the answer is a document worth keeping, not just reading.",
  inputSchema: z.object({
    filename: z.string().describe("File name with extension, e.g. 'offer.md'"),
    mediaType: z
      .string()
      .describe("IANA media type, e.g. 'text/markdown' or 'text/csv'"),
    content: z.string().describe("The complete file contents"),
  }),
  async execute({ filename, mediaType, content }) {
    const bytes = new TextEncoder().encode(content);
    return {
      filename,
      mediaType,
      size: bytes.byteLength,
      url: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  },
});
