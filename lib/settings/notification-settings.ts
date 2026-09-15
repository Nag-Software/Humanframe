import type { RequestScope } from "@/server/db/request-scope";

export type NotificationSettingsValues = {
  emailEnabled: boolean;
  reminders: boolean;
  backgroundDone: boolean;
  approvalNeeded: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettingsValues = {
  emailEnabled: false,
  reminders: true,
  backgroundDone: true,
  approvalNeeded: true,
  quietHoursStart: "",
  quietHoursEnd: "",
  timezone: "",
};

type NotificationSettingsRow = {
  email_enabled: boolean;
  reminders: boolean;
  background_done: boolean;
  approval_needed: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string | null;
};

export function notificationSettingsFromRow(
  data: NotificationSettingsRow | null
): NotificationSettingsValues {
  return {
    emailEnabled:
      data?.email_enabled ?? DEFAULT_NOTIFICATION_SETTINGS.emailEnabled,
    reminders: data?.reminders ?? DEFAULT_NOTIFICATION_SETTINGS.reminders,
    backgroundDone:
      data?.background_done ?? DEFAULT_NOTIFICATION_SETTINGS.backgroundDone,
    approvalNeeded:
      data?.approval_needed ?? DEFAULT_NOTIFICATION_SETTINGS.approvalNeeded,
    quietHoursStart: data?.quiet_hours_start?.slice(0, 5) ?? "",
    quietHoursEnd: data?.quiet_hours_end?.slice(0, 5) ?? "",
    timezone: data?.timezone ?? "",
  };
}

export async function loadNotificationSettings(
  scope: Pick<RequestScope, "client" | "workspaceId" | "userId">
): Promise<NotificationSettingsValues> {
  const { data } = await scope.client
    .from("notification_settings")
    .select(
      "email_enabled, reminders, background_done, approval_needed, " +
        "quiet_hours_start, quiet_hours_end, timezone"
    )
    .eq("workspace_id", scope.workspaceId)
    .eq("user_id", scope.userId)
    .maybeSingle<NotificationSettingsRow>();

  return notificationSettingsFromRow(data);
}
