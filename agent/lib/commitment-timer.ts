import { sleep } from "workflow";

import { wakeCommitment } from "./wake";

/**
 * A commitment's own clock.
 *
 * One detached durable workflow per commitment: it sleeps until the deadline
 * and then enters the same claim every other wake path uses. Detached — started
 * with `start()` rather than as a tool of a session — for two reasons:
 *
 *  - a session-attached background task notifies the parent agent whenever its
 *    run ends, so a cancelled commitment could not end quietly. This can;
 *  - the run outlives the conversation that created it, which a task tied to a
 *    session's lifetime would not.
 *
 * The workflow's identity is this module path plus the function name, so
 * neither may be renamed while runs are in flight.
 */
export async function commitmentTimer(input: {
  commitmentId: string;
  dueAt: string;
}): Promise<void> {
  "use workflow";
  await sleep(untilDue(input.dueAt));
  await fireWake(input.commitmentId);
}

/**
 * The claim decides whether anything happens at all. A commitment that was
 * completed or cancelled while this slept is not in `scheduled` or `waking`,
 * so no row comes back, nothing is delivered, and no turn is started.
 */
async function fireWake(commitmentId: string): Promise<void> {
  "use step";
  const outcome = await wakeCommitment(commitmentId);
  console.log(
    JSON.stringify({ level: "info", event: "commitment.timer_fired", commitmentId, outcome })
  );
}

/** Seconds from now until the deadline, floored at zero. */
export function untilDue(dueAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((new Date(dueAt).getTime() - now) / 1000));
  return `${seconds}s`;
}
