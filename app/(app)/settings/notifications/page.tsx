import type { Metadata } from "next";

import { getTranslations } from "@/lib/i18n";
import { getRequestScope } from "@/server/db/request-scope";

import { NotificationSettingsForm } from "./form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.settings.pages.notifications.metaTitle };
}

type Settings = {
  email_enabled: boolean;
  reminders: boolean;
  background_done: boolean;
  approval_needed: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string | null;
};

export default async function NotificationSettingsPage() {
  const [scope, t] = await Promise.all([
    getRequestScope(),
    getTranslations(),
  ]);
  if (!scope) {
    return null;
  }

  const { data } = await scope.client
    .from("notification_settings")
    .select(
      "email_enabled, reminders, background_done, approval_needed, " +
        "quiet_hours_start, quiet_hours_end, timezone"
    )
    .eq("workspace_id", scope.workspaceId)
    .eq("user_id", scope.userId)
    .maybeSingle<Settings>();

  const copy = t.settings.pages.notifications;

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{copy.title}</h2>
        <p className="text-muted-foreground text-sm">{copy.description}</p>
      </div>
      <NotificationSettingsForm
        settings={{
          emailEnabled: data?.email_enabled ?? false,
          reminders: data?.reminders ?? true,
          backgroundDone: data?.background_done ?? true,
          approvalNeeded: data?.approval_needed ?? true,
          quietHoursStart: data?.quiet_hours_start?.slice(0, 5) ?? "",
          quietHoursEnd: data?.quiet_hours_end?.slice(0, 5) ?? "",
          timezone: data?.timezone ?? "",
        }}
        email={scope.email}
      />
    </section>
  );
}
