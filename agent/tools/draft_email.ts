import { defineTool } from "eve/tools";
import { z } from "zod";

/** A structured email draft rendered as a draft card. Nothing is sent. */
export default defineTool({
  description:
    "Deliver an email draft in structured form so the user can read, edit and " +
    "copy it. This never sends anything.",
  inputSchema: z.object({
    to: z.array(z.string()).describe("Recipients"),
    subject: z.string(),
    body: z.string().describe("Body in markdown"),
  }),
  async execute(input) {
    return input;
  },
});
