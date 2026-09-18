import { z } from "zod";

import { correctFact, retractFact } from "@/server/db/repositories/memory";
import { getRequestScope } from "@/server/db/request-scope";
import { LIMITS, rateLimitedResponse, takeRateLimit } from "@/server/rate-limit";

/**
 * What the user may do to what Maya remembers: correct it, or take it away.
 * Both go through the user's own client, so a fact in another workspace is
 * simply not found.
 */
const paramsSchema = z.object({ factId: z.uuid() });
const patchSchema = z.object({ value: z.string().min(1).max(500) });

export async function PATCH(
  req: Request,
  context: RouteContext<"/api/assistants/maya/memory/[factId]">
) {
  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = paramsSchema.safeParse(await context.params);
  const body = patchSchema.safeParse(await req.json().catch(() => null));
  if (!params.success || !body.success) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!(await takeRateLimit(scope.client, LIMITS.memoryEdit))) {
    return rateLimitedResponse(LIMITS.memoryEdit);
  }

  const fact = await correctFact(
    scope.client,
    scope.workspaceId,
    params.data.factId,
    body.data.value
  );
  if (!fact) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ fact });
}

export async function DELETE(
  _req: Request,
  context: RouteContext<"/api/assistants/maya/memory/[factId]">
) {
  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!(await takeRateLimit(scope.client, LIMITS.memoryEdit))) {
    return rateLimitedResponse(LIMITS.memoryEdit);
  }

  const removed = await retractFact(
    scope.client,
    scope.workspaceId,
    params.data.factId
  );
  if (!removed) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
