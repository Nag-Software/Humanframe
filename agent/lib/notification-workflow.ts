import { sendNotification } from "./notification-sender";

/**
 * A notification's own durable run.
 *
 * Started right after the outbox row is committed, so a normal notification
 * goes out in seconds rather than waiting for the daily heartbeat. Detached,
 * like the commitment timer: it must not be tied to the session that produced
 * the message, and it must be able to end without saying anything to the agent.
 *
 * Its identity is this module path plus the function name, so neither may be
 * renamed while runs are in flight.
 */
export async function notificationSender(input: { jobId: string }): Promise<void> {
  "use workflow";
  await deliverNotification(input.jobId);
}

async function deliverNotification(jobId: string): Promise<void> {
  "use step";
  const outcome = await sendNotification(jobId);
  console.log(
    JSON.stringify({ level: "info", event: "notification.sent", jobId, outcome })
  );
}
