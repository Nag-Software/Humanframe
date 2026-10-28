import { defineSchedule } from "eve/schedules";

import { callCronRoute } from "../lib/cron-call";

/**
 * The receptionist's safety net: post-call processing that failed, was
 * stranded by a crashed worker, or never got its recording webhook. Normally
 * a call is processed seconds after it ends and this finds nothing.
 *
 * Daily for the same reason as the heartbeat (Hobby rejects sub-daily cron).
 * The work itself lives in the Next app; this only knocks on its door, so the
 * receptionist code is not bundled twice.
 */
export default defineSchedule({
  cron: "15 5 * * *",
  run({ waitUntil }) {
    waitUntil(callCronRoute("/api/cron/receptionist"));
  },
});
