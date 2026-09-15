import type { NotificationEvent } from "./notifications";

/**
 * One template, three occasions.
 *
 * The email is a doorbell, not a delivery. It says that something happened and
 * links to the conversation — it never carries the content: no document bodies,
 * no tool input, no customer data, no quoted message text. Whatever Maya
 * actually produced stays behind the app's own sign-in, where access control
 * applies. Approvals in particular are only ever granted inside the app; the
 * email cannot approve anything.
 */

export type TemplateInput = {
  event: NotificationEvent;
  /** Short, neutral, and safe to sit in an inbox. */
  title: string;
  threadUrl: string;
  settingsUrl: string;
};

const COPY: Record<NotificationEvent, { subject: string; line: string }> = {
  reminder: {
    subject: "A reminder from Maya",
    line: "Maya came back to something you asked her to follow up on.",
  },
  background_done: {
    subject: "Maya finished something",
    line: "Work Maya was doing in the background has finished.",
  },
  approval_needed: {
    subject: "Maya needs your approval",
    line: "Maya has paused and needs you to approve a step before she continues.",
  },
};

export function renderNotification(input: TemplateInput): {
  subject: string;
  html: string;
  text: string;
} {
  const copy = COPY[input.event];
  const title = sanitiseTitle(input.title);

  const text = [
    copy.line,
    "",
    title,
    "",
    `Open the conversation: ${input.threadUrl}`,
    "",
    `Notification settings: ${input.settingsUrl}`,
  ].join("\n");

  return { subject: copy.subject, text, html: html(copy.line, title, input) };
}

/**
 * The title comes from a commitment or task the user themselves phrased, so it
 * is trimmed and escaped rather than trusted. Anything longer than a line is
 * cut: a subject that spills is a subject that leaks.
 */
export function sanitiseTitle(title: string): string {
  const flattened = title.replace(/\s+/g, " ").trim();
  const clipped = flattened.length > 120 ? `${flattened.slice(0, 117)}…` : flattened;
  return escapeHtml(clipped);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function html(line: string, title: string, input: TemplateInput): string {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f6f6f5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:#f6f6f5;padding:48px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
            style="max-width:480px;background:#ffffff;border-radius:14px;
                   border:1px solid #e7e6e3;">
            <tr>
              <td style="padding:32px 32px 8px 32px;font-family:-apple-system,
                         BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
                <p style="margin:0 0 24px 0;font-size:13px;letter-spacing:0.08em;
                          text-transform:uppercase;color:#8a8780;">Humanframe</p>
                <p style="margin:0 0 8px 0;font-size:16px;line-height:1.5;
                          color:#1a1917;">${line}</p>
                <p style="margin:0;font-size:16px;line-height:1.5;color:#55524c;">
                  ${title}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px 32px;">
                <a href="${input.threadUrl}"
                   style="display:inline-block;background:#1a1917;color:#ffffff;
                          text-decoration:none;font-family:-apple-system,
                          BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
                          font-size:14px;padding:11px 20px;border-radius:8px;">
                  Open the conversation
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px 32px;font-family:-apple-system,
                         BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
                <p style="margin:0;font-size:12px;line-height:1.5;color:#8a8780;">
                  You are getting this because email notification is on.
                  <a href="${input.settingsUrl}" style="color:#8a8780;">
                    Change what Maya emails you about</a>.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Links always point at the configured app origin and Humanframe's own thread
 * id. The eve session id is never a public identifier, and an origin taken from
 * a request header would be an open redirect waiting to happen.
 */
export function threadUrl(origin: string, threadId: string): string {
  return `${trimSlash(origin)}/assistants/maya?t=${encodeURIComponent(threadId)}`;
}

export function settingsUrl(origin: string): string {
  return `${trimSlash(origin)}/settings/notifications`;
}

function trimSlash(origin: string): string {
  return origin.replace(/\/+$/, "");
}
