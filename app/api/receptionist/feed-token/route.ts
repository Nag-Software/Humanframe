import { randomBytes } from "node:crypto";

import { requireApiScope } from "@/server/receptionist/scope";

/** Rotates the calendar feed token: every old subscription URL stops working. */
export async function POST() {
  const auth = await requireApiScope({ configure: true });
  if ("response" in auth) return auth.response;
  const token = randomBytes(24).toString("hex");
  const { error } = await auth.scope.client
    .from("business_profiles")
    .update({ calendar_feed_token: token })
    .eq("workspace_id", auth.scope.workspaceId);
  if (error) return Response.json({ error: "save_profile_first" }, { status: 409 });
  return Response.json({ token });
}
