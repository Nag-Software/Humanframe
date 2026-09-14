import { disableTool } from "eve/tools";

/**
 * Disabled on purpose.
 *
 * `ask_question` parks the turn behind a framework prompt. Our thread renders
 * that as a bare tool call, so the user sees "used a tool" and never the
 * question. Maya asks in her own words instead; approvals keep their own card.
 */
export default disableTool();
