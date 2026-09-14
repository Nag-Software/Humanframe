import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { webFetch } from "eve/tools/web_fetch";

/**
 * eve's own fetcher, gated behind approval. Reading an arbitrary URL on the
 * server is a request the user should see before it runs, and the approval also
 * keeps a replayed step from re-fetching without a fresh decision.
 */
export default defineTool({
  ...webFetch,
  approval: always(),
});
