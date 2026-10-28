import { defineSchedule } from "eve/schedules";

import { callCronRoute } from "../lib/cron-call";

/**
 * Monday 06:00 UTC — 07:00 or 08:00 in Oslo — last week's report goes to
 * every workspace with a live number. Idempotent per workspace and week.
 */
export default defineSchedule({
  cron: "0 6 * * 1",
  run({ waitUntil }) {
    waitUntil(callCronRoute("/api/cron/weekly-report"));
  },
});
