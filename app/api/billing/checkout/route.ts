import { z } from "zod";

import { errorFields, logger } from "@/lib/logger";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { createCheckoutSession } from "@/server/billing/checkout";
import { billingEnabled } from "@/server/billing/stripe";
import { getRequestScope } from "@/server/db/request-scope";
import { LIMITS, rateLimitedResponse, takeRateLimit } from "@/server/rate-limit";

/**
 * Starts Stripe Checkout for a plan. Only a workspace owner or admin may put
 * the workspace on a plan; the answer is a URL the browser goes to.
 */
const bodySchema = z.object({
  plan: z.enum(["starter", "pro"]),
  interval: z.enum(["month", "year"]),
});

export async function POST(req: Request) {
  if (!billingEnabled()) {
    return Response.json({ error: "Billing is not enabled" }, { status: 404 });
  }

  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (scope.workspace.role === "member") {
    return Response.json({ error: "Only an owner or admin can change the plan" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!(await takeRateLimit(scope.client, LIMITS.billing))) {
    return rateLimitedResponse(LIMITS.billing);
  }

  try {
    const { url } = await createCheckoutSession(getServiceRoleClient(), {
      workspaceId: scope.workspaceId,
      workspaceName: scope.workspace.name,
      email: scope.email,
      plan: parsed.data.plan,
      interval: parsed.data.interval,
      origin: new URL(req.url).origin,
    });
    return Response.json({ url });
  } catch (error) {
    if (error instanceof Error && error.message === "already_subscribed") {
      return Response.json({ error: "already_subscribed" }, { status: 409 });
    }
    logger.error("billing.checkout_failed", {
      workspaceId: scope.workspaceId,
      ...errorFields(error),
    });
    return Response.json({ error: "Could not start checkout" }, { status: 502 });
  }
}
