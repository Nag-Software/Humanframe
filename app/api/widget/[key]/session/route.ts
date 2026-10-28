import { getServiceRoleClient } from "@/lib/supabase/server";
import { profileForWidget, startSession } from "@/server/widget/sessions";

/** Starts a conversation in a business's website widget. */
export async function POST(request: Request, context: RouteContext<"/api/widget/[key]/session">) {
  const { key } = await context.params;
  const admin = getServiceRoleClient();
  const profile = await profileForWidget(admin, key);
  if (!profile) return Response.json({ error: "not_found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { origin?: string };
  const started = await startSession(admin, profile, body.origin ?? request.headers.get("referer"));
  if ("error" in started) return Response.json({ error: started.error }, { status: 429 });
  return Response.json(started);
}
