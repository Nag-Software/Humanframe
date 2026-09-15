import { defineChannel, POST } from "eve/channels";
import { createUnauthorizedResponse } from "eve/channels/auth";

import { commitmentTimer } from "../lib/commitment-timer";
import {
  currentProjectBinding,
  verifyInternalCaller,
} from "../lib/internal-auth";
import { INTERNAL_TIMER_PATH } from "../lib/internal-routes";
import { getRuntimeSupabase } from "../lib/supabase";

/**
 * Humanframe's own internal surface.
 *
 * It exists for one reason: a durable workflow can only be started from inside
 * the eve runtime, because the `workflow` module is resolved by eve's bundler
 * and does not exist in the Next.js build. Anything the app needs to schedule —
 * today, a commitment made out loud during a call — is therefore asked for
 * here, over HTTP, by the same deployment.
 *
 * The request proves it is us with the phase 4 OIDC check: right project, right
 * environment, machine principal, fresh token. It carries no scope at all. The
 * commitment id is looked up server-side and the row is the only thing trusted;
 * a caller that can prove it is this deployment still cannot choose whose
 * commitment gets a clock, because it does not get to describe one.
 */
export default defineChannel({
  routes: [
    POST(INTERNAL_TIMER_PATH, async (request) => {
      const header = request.headers.get("authorization");
      const claimsInternal =
        request.headers.get("x-humanframe-internal") === "delivery";

      if (!header?.startsWith("Bearer ") || !claimsInternal) {
        return createUnauthorizedResponse({
          message: "Internal callers only.",
          challenges: [{ scheme: "Bearer" }],
        });
      }

      const outcome = await verifyInternalCaller(
        header.slice("Bearer ".length),
        currentProjectBinding()
      );

      if (!outcome.ok) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "internal.timer_rejected",
            reason: outcome.reason,
          })
        );
        return createUnauthorizedResponse({
          status: 403,
          message: "Not an internal caller.",
          challenges: [{ scheme: "Bearer" }],
        });
      }

      const body = (await request.json().catch(() => null)) as {
        commitmentId?: unknown;
      } | null;

      const commitmentId = body?.commitmentId;
      if (typeof commitmentId !== "string" || commitmentId.length === 0) {
        return Response.json({ error: "commitmentId is required" }, { status: 400 });
      }

      const client = getRuntimeSupabase();
      if (!client) {
        return Response.json({ error: "No database" }, { status: 503 });
      }

      // The row decides. A commitment that is finished, cancelled or gone gets
      // no clock, whatever the caller asked for.
      const { data: commitment } = await client
        .from("commitments")
        .select("id, due_at, status")
        .eq("id", commitmentId)
        .maybeSingle<{ id: string; due_at: string; status: string }>();

      if (!commitment) {
        return Response.json({ error: "Unknown commitment" }, { status: 404 });
      }
      if (commitment.status !== "scheduled") {
        return Response.json({ started: false, reason: commitment.status });
      }

      try {
        const { start } = await import("workflow/api");
        await start(commitmentTimer, [
          { commitmentId: commitment.id, dueAt: commitment.due_at },
        ]);
      } catch (error) {
        // The promise to the user is the committed row, not the workflow. A
        // failure here is reported so the caller can log it, and the daily
        // heartbeat remains the backstop.
        console.error(
          JSON.stringify({
            level: "error",
            event: "internal.timer_start_failed",
            commitmentId: commitment.id,
            error: error instanceof Error ? error.message : String(error),
          })
        );
        return Response.json({ started: false, reason: "start_failed" }, { status: 502 });
      }

      return Response.json({ started: true });
    }),
  ],
});
