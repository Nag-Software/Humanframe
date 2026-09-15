"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getTranslations } from "@/lib/i18n";
import { getRequestScope } from "@/server/db/request-scope";

/**
 * Notification preferences.
 *
 * Written by the signed-in person as themselves: the row's policy requires
 * `user_id = auth.uid()`, so this cannot edit anyone else's settings even if
 * the form said otherwise. The recipient address is never part of this — it
 * comes from the verified user record when an email is actually sent.
 */

const schema = z.object({
  emailEnabled: z.boolean(),
  reminders: z.boolean(),
  backgroundDone: z.boolean(),
  approvalNeeded: z.boolean(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  timezone: z.string().min(1).max(64).nullable(),
});

export type NotificationFormState = { ok: boolean; message?: string };

export async function saveNotificationSettings(
  _previous: NotificationFormState,
  formData: FormData
): Promise<NotificationFormState> {
  const t = await getTranslations();
  const copy = t.settings.notifications.form;
  const scope = await getRequestScope();
  if (!scope) {
    return { ok: false, message: copy.signInRequired };
  }

  const quietStart = formData.get("quietHoursStart");
  const quietEnd = formData.get("quietHoursEnd");

  const parsed = schema.safeParse({
    emailEnabled: formData.get("emailEnabled") === "on",
    reminders: formData.get("reminders") === "on",
    backgroundDone: formData.get("backgroundDone") === "on",
    approvalNeeded: formData.get("approvalNeeded") === "on",
    quietHoursStart: quietStart ? String(quietStart) || null : null,
    quietHoursEnd: quietEnd ? String(quietEnd) || null : null,
    timezone: formData.get("timezone") ? String(formData.get("timezone")) : null,
  });

  if (!parsed.success) {
    return { ok: false, message: copy.invalid };
  }

  const { error } = await scope.client.from("notification_settings").upsert(
    {
      workspace_id: scope.workspaceId,
      user_id: scope.userId,
      email_enabled: parsed.data.emailEnabled,
      reminders: parsed.data.reminders,
      background_done: parsed.data.backgroundDone,
      approval_needed: parsed.data.approvalNeeded,
      quiet_hours_start: parsed.data.quietHoursStart,
      quiet_hours_end: parsed.data.quietHoursEnd,
      timezone: parsed.data.timezone,
    },
    { onConflict: "workspace_id,user_id" }
  );

  if (error) {
    return { ok: false, message: copy.saveFailed };
  }

  revalidatePath("/settings/notifications");
  return { ok: true, message: copy.saved };
}
