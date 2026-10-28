import { getServiceRoleClient } from "@/lib/supabase/server";
import { isCronRequest } from "@/server/cron";
import { processInquiry } from "@/server/receptionist/processing";

/**
 * The safety net under post-call processing: anything that failed, was
 * stranded by a crashed worker, or never got its recording webhook.
 */

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isCronRequest(request)) return new Response("Forbidden", { status: 403 });
  const outcomes = await processInquiry(getServiceRoleClient(), null, 10);
  return Response.json({ processed: outcomes.length, failed: outcomes.filter((o) => !o.ok).length });
}
