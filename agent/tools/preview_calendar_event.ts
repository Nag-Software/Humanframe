import { defineTool } from "eve/tools";
import { z } from "zod";

/** Proposes a calendar event. Maya creates nothing here. */
export default defineTool({
  description:
    "Show a proposed calendar event. This only proposes it; it does not create " +
    "the event.",
  inputSchema: z.object({
    title: z.string(),
    start: z.string().describe("ISO 8601 start time"),
    end: z.string().describe("ISO 8601 end time"),
    location: z.string().optional(),
    attendees: z.array(z.string()).optional(),
    notes: z.string().optional(),
  }),
  async execute(input) {
    return input;
  },
});
