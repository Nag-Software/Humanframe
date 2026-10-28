import { z } from "zod";

import { getServiceRoleClient } from "@/lib/supabase/server";
import { LIMITS, rateLimitedResponse, takeRateLimit } from "@/server/rate-limit";
import { decideAction } from "@/server/receptionist/execute";
import { requireApiScope } from "@/server/receptionist/scope";
import { getAction } from "@/server/receptionist/store";

/** The one tap: approve (optionally edited) or dismiss a proposal. */

export const maxDuration = 60;

const schema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("dismiss") }),
  z.object({
    decision: z.literal("approve"),
    payload: z.record(z.string(), z.unknown()).optional(),
    force: z.boolean().optional(),
  }),
]);

export async function POST(request: Request, context: RouteContext<"/api/receptionist/actions/[actionId]">) {
  const auth = await requireApiScope();
  if ("response" in auth) return auth.response;
  const { scope } = auth;

  const { actionId } = await context.params;
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(actionId).success || !body.success) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  if (!(await takeRateLimit(scope.client, LIMITS.receptionistDecide))) {
    return rateLimitedResponse(LIMITS.receptionistDecide);
  }

  // Read through the user's own client: an action in another workspace is
  // simply not found.
  const action = await getAction(scope.client, actionId, scope.workspaceId);
  if (!action) return Response.json({ error: "not_found" }, { status: 404 });

  const result = await decideAction(getServiceRoleClient(), {
    action,
    userId: scope.userId,
    decision:
      body.data.decision === "dismiss"
        ? { kind: "dismiss" }
        : { kind: "approve", payload: body.data.payload, force: body.data.force },
  });

  if (!result.ok) {
    const status = result.reason === "already_decided" ? 409 : result.reason === "clash" ? 409 : result.reason === "invalid" ? 400 : 502;
    return Response.json({ error: result.reason, message: result.message }, { status });
  }
  return Response.json({ action: result.action });
}
