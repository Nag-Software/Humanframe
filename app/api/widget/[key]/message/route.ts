import { z } from "zod";

import { getServiceRoleClient } from "@/lib/supabase/server";
import { profileForWidget, takeTurn } from "@/server/widget/sessions";

export const maxDuration = 60;

const schema = z.object({ sessionId: z.string(), text: z.string().max(2000) });

/** One turn of the website conversation. */
export async function POST(request: Request, context: RouteContext<"/api/widget/[key]/message">) {
  const { key } = await context.params;
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid" }, { status: 400 });

  const admin = getServiceRoleClient();
  const profile = await profileForWidget(admin, key);
  if (!profile) return Response.json({ error: "not_found" }, { status: 404 });

  const result = await takeTurn(admin, profile, body.data.sessionId, body.data.text);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : result.error === "failed" ? 502 : result.error === "limit" ? 429 : 400;
    return Response.json({ error: result.error }, { status });
  }
  return Response.json(result);
}
