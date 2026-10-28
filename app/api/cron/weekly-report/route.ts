import { errorFields, logger } from "@/lib/logger";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { isCronRequest } from "@/server/cron";
import { sendWeeklyReport } from "@/server/receptionist/report";
import { loadProfile } from "@/server/receptionist/store";

/**
 * Monday morning: last week's report for every workspace with a live number.
 * Idempotent per (workspace, week), so a re-run sends nothing twice.
 */

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isCronRequest(request)) return new Response("Forbidden", { status: 403 });

  const admin = getServiceRoleClient();
  const { data } = await admin
    .from("phone_numbers")
    .select("workspace_id")
    .eq("status", "active")
    .returns<{ workspace_id: string }[]>();
  const workspaces = [...new Set((data ?? []).map((row) => row.workspace_id))];

  const results: Record<string, number> = {};
  for (const workspaceId of workspaces) {
    try {
      const profile = await loadProfile(admin, workspaceId);
      const outcome = await sendWeeklyReport(admin, profile);
      results[outcome] = (results[outcome] ?? 0) + 1;
    } catch (error) {
      logger.error("report.workspace_failed", { workspaceId, ...errorFields(error) });
      results.failed = (results.failed ?? 0) + 1;
    }
  }
  return Response.json({ workspaces: workspaces.length, results });
}
