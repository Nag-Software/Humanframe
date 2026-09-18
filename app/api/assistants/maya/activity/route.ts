import { listLiveActivity } from "@/server/db/repositories/activity";
import { getAssistantBySlug } from "@/server/db/repositories/assistants";
import { getRequestScope } from "@/server/db/request-scope";
import { LIMITS, rateLimitedResponse, takeRateLimit } from "@/server/rate-limit";

/** The sidebar polls this to keep "Right now" live. Read-only. */
export async function GET() {
  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await takeRateLimit(scope.client, LIMITS.activity))) {
    return rateLimitedResponse(LIMITS.activity);
  }

  const assistant = await getAssistantBySlug(
    scope.client,
    scope.workspaceId,
    "maya"
  );
  if (!assistant) {
    return Response.json({ items: [] });
  }

  const items = await listLiveActivity(
    scope.client,
    scope.workspaceId,
    assistant.id
  );
  return Response.json(
    { items },
    { headers: { "cache-control": "no-store" } }
  );
}
