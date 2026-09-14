import { z } from "zod";

import { linkEveSession } from "@/server/db/repositories/threads";
import { getRequestScope } from "@/server/db/request-scope";

const bodySchema = z.object({
  threadId: z.uuid(),
  sessionId: z.string().min(1).max(200),
});

/** Binds a thread to the eve session that now carries its conversation. */
export async function POST(req: Request) {
  const scope = await getRequestScope();
  if (!scope) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  await linkEveSession(scope, parsed.data.threadId, parsed.data.sessionId);
  return Response.json({ ok: true });
}
