import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * Per-user rate limits on the routes a browser can hit.
 *
 * The budget lives in Postgres (`take_rate_limit`), so it holds across
 * serverless instances and cannot be spent on someone else's behalf: the
 * function keys on `auth.uid()` and ignores whatever the caller claims.
 *
 * A limiter that cannot be reached fails open, loudly. It protects spend and
 * abuse; it is not a security boundary, and an outage in it must not take the
 * product down with it.
 */
export type RateLimit = {
  bucket: string;
  limit: number;
  windowSeconds: number;
};

export const LIMITS = {
  sessionStart: { bucket: "session.start", limit: 12, windowSeconds: 60 },
  upload: { bucket: "upload", limit: 30, windowSeconds: 60 },
  activity: { bucket: "activity", limit: 120, windowSeconds: 60 },
  memoryEdit: { bucket: "memory.edit", limit: 30, windowSeconds: 60 },
  callStart: { bucket: "call.start", limit: 10, windowSeconds: 60 },
  billing: { bucket: "billing", limit: 10, windowSeconds: 60 },
} as const satisfies Record<string, RateLimit>;

export async function takeRateLimit(
  client: SupabaseClient,
  rule: RateLimit
): Promise<boolean> {
  const { data, error } = await client.rpc("take_rate_limit", {
    p_bucket: rule.bucket,
    p_limit: rule.limit,
    p_window_seconds: rule.windowSeconds,
  });

  if (error) {
    logger.error("rate_limit.unavailable", {
      bucket: rule.bucket,
      message: error.message,
    });
    return true;
  }
  return data === true;
}

export function rateLimitedResponse(rule: RateLimit): Response {
  return Response.json(
    { error: "Too many requests" },
    {
      status: 429,
      headers: { "retry-after": String(rule.windowSeconds) },
    }
  );
}
