import { defineSchedule } from "eve/schedules";

import { sweepWakes } from "../lib/wake";

/**
 * The reconciler.
 *
 * Each commitment has its own durable timer, so on a healthy deployment this
 * finds nothing. It exists for the cases a timer cannot cover: a run lost to a
 * workflow-storage expiry, a `start()` that failed after the commitment row was
 * written, or a delivery abandoned mid-flight when a worker died.
 *
 * Its cadence therefore bounds *recovery* latency, not wake latency. It claims
 * through exactly the same atomic function the timers use, so a sweep that
 * overlaps a timer cannot double-deliver: one of them gets the lease and the
 * other gets nothing.
 */
export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(
      (async () => {
        const outcomes = await sweepWakes({ limit: 25 });
        if (outcomes.length > 0) {
          console.log(
            JSON.stringify({
              level: "info",
              event: "heartbeat.recovered",
              count: outcomes.length,
              outcomes,
            })
          );
        }
      })()
    );
  },
});
