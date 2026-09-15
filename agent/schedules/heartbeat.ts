import { defineSchedule } from "eve/schedules";

import { sweepNotifications } from "../lib/notification-sender";
import { sweepWakes } from "../lib/wake";

/**
 * The reconciler.
 *
 * Each commitment has its own durable timer, so on a healthy deployment this
 * finds nothing. It exists for the cases a timer cannot cover: a run lost to a
 * workflow-storage expiry, a `start()` that failed after the commitment row was
 * written, or a delivery abandoned mid-flight when a worker died.
 *
 * It sweeps two queues: commitments whose timer never fired, and notification
 * jobs whose own run never started or died mid-send. Both use the same claim
 * discipline, so a sweep overlapping a live run cannot double-deliver.
 *
 * Its cadence therefore bounds *recovery* latency, not wake latency. It claims
 * through exactly the same atomic function the timers use, so a sweep that
 * overlaps a timer cannot double-deliver: one of them gets the lease and the
 * other gets nothing.
 *
 * Daily, because Vercel's Hobby plan rejects any cron that would run more than
 * once a day — a minute-level expression fails the deployment outright. On Pro,
 * change this to "*\/5 * * * *": nothing else about the design depends on it,
 * and recovery would go from up to a day to a few minutes.
 *
 * The cost of a daily sweep is carried entirely by the timers. If a
 * commitment's own workflow fires, the user never waits on this at all. If
 * timers turn out not to start, this cadence becomes the wake latency, which
 * would not be an acceptable product — so proving the timer at runtime (P3) is
 * what makes a daily reconciler safe.
 */
export default defineSchedule({
  cron: "0 6 * * *",
  run({ waitUntil }) {
    waitUntil(
      (async () => {
        const wakes = await sweepWakes({ limit: 25 });
        const notifications = await sweepNotifications({ limit: 25 });
        if (wakes.length > 0 || notifications.length > 0) {
          console.log(
            JSON.stringify({
              level: "info",
              event: "heartbeat.recovered",
              wakes,
              notifications,
            })
          );
        }
      })()
    );
  },
});
