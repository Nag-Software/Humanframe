import { errorFields, logger } from "@/lib/logger";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { createPortalSession, ensureCustomer } from "@/server/billing/checkout";
import { billingEnabled } from "@/server/billing/stripe";
import { getRequestScope } from "@/server/db/request-scope";
import { LIMITS, rateLimitedResponse, takeRateLimit } from "@/server/rate-limit";

/** The Stripe customer portal: plan changes, card, cancellation, invoices. */
export async function POST(req: Request) {
  if (!billingEnabled()) {
    return Response.json({ error: "Billing is not enabled" }, { status: 404 });
  }

  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (scope.workspace.role === "member") {
    return Response.json({ error: "Only an owner or admin can manage billing" }, { status: 403 });
  }

  if (!(await takeRateLimit(scope.client, LIMITS.billing))) {
    return rateLimitedResponse(LIMITS.billing);
  }

  try {
    const customerId = await ensureCustomer(getServiceRoleClient(), {
      workspaceId: scope.workspaceId,
      workspaceName: scope.workspace.name,
      email: scope.email,
    });
    const { url } = await createPortalSession({
      customerId,
      origin: new URL(req.url).origin,
    });
    return Response.json({ url });
  } catch (error) {
    logger.error("billing.portal_failed", {
      workspaceId: scope.workspaceId,
      ...errorFields(error),
    });
    return Response.json({ error: "Could not open billing" }, { status: 502 });
  }
}
