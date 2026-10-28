import { z } from "zod";

import { errorFields, logger } from "@/lib/logger";
import { LIMITS, rateLimitedResponse, takeRateLimit } from "@/server/rate-limit";
import { learnFromWebsite, mergeDraft } from "@/server/receptionist/onboarding";
import { profileInputSchema } from "@/server/receptionist/profile";
import { requireApiScope } from "@/server/receptionist/scope";
import { loadProfile } from "@/server/receptionist/store";
import { UnsafeUrlError } from "@/server/receptionist/web";

/**
 * Reads the business's website and returns a draft profile. Nothing is
 * saved: the owner reviews the draft in Oppsett and saves what is right.
 */

export const maxDuration = 120;

const schema = z.object({ url: z.string().trim().min(3).max(500) });

export async function POST(request: Request) {
  const auth = await requireApiScope({ configure: true });
  if ("response" in auth) return auth.response;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_url" }, { status: 400 });

  if (!(await takeRateLimit(auth.scope.client, LIMITS.receptionistLearn))) {
    return rateLimitedResponse(LIMITS.receptionistLearn);
  }

  try {
    const learned = await learnFromWebsite(parsed.data.url);
    const current = await loadProfile(auth.scope.client, auth.scope.workspaceId, auth.scope.workspace.name);
    const base = profileInputSchema.parse(current);
    // A fresh read replaces what the website said last time, but never what
    // the owner typed: fields still at their default are filled, others kept.
    const draft = profileInputSchema.parse(mergeDraft(base, learned.draft));
    return Response.json({ draft, sources: learned.sources, hoursFound: learned.hoursFound });
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return Response.json({ error: "invalid_url", message: error.message }, { status: 400 });
    }
    logger.warn("receptionist.learn_failed", errorFields(error));
    return Response.json(
      { error: "fetch_failed", message: error instanceof Error ? error.message : "failed" },
      { status: 502 }
    );
  }
}
