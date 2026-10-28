import { internalOrigin } from "./wake";

/**
 * Calls one of the app's cron routes with CRON_SECRET. Logs and returns; a
 * schedule has nobody to throw to.
 */
export async function callCronRoute(path: string): Promise<void> {
  const origin = internalOrigin();
  const secret = process.env.CRON_SECRET;
  if (!origin || !secret) {
    console.warn(JSON.stringify({ level: "warn", event: "cron.unconfigured", path }));
    return;
  }
  try {
    const response = await fetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(290_000),
    });
    console.log(
      JSON.stringify({
        level: response.ok ? "info" : "error",
        event: "cron.called",
        path,
        status: response.status,
        body: (await response.text().catch(() => "")).slice(0, 500),
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "cron.failed",
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
}
