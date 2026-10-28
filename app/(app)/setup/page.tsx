import type { Metadata } from "next";

import { appOrigin } from "@/agent/lib/email-template";
import { SetupForm } from "@/components/receptionist/setup-form";
import { Page, PageHeader } from "@/components/hf/page";
import { getTranslations } from "@/lib/i18n";
import { requireRequestScope } from "@/server/db/request-scope";
import { profileInputSchema, profileReadiness } from "@/server/receptionist/profile";
import { canConfigure } from "@/server/receptionist/scope";
import { listPhoneNumbers, loadProfile } from "@/server/receptionist/store";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.receptionist.setup.metaTitle };
}

/** Everything the owner sets up once: what the receptionist knows, and where calls go. */
export default async function SetupPage() {
  const scope = await requireRequestScope();
  const [t, profile, numbers, calendar] = await Promise.all([
    getTranslations(),
    loadProfile(scope.client, scope.workspaceId, scope.workspace.name),
    listPhoneNumbers(scope.client, scope.workspaceId),
    scope.client
      .from("connector_accounts")
      .select("id, account_email")
      .eq("workspace_id", scope.workspaceId)
      .eq("provider", "googlecalendar")
      .eq("status", "active")
      .limit(1)
      .maybeSingle<{ id: string; account_email: string | null }>(),
  ]);
  const copy = t.receptionist.setup;
  const origin = appOrigin() ?? "";

  return (
    <Page>
      <PageHeader eyebrow={profile.name || scope.workspace.name} title={copy.title} description={copy.description} />
      <SetupForm
        initialProfile={profileInputSchema.parse(profile)}
        initialReadiness={profileReadiness(profile)}
        learnedFrom={profile.learnedFrom}
        number={numbers[0] ? { e164: numbers[0].e164, forwardedFrom: numbers[0].forwardedFrom } : null}
        calendar={calendar.data ? { email: calendar.data.account_email } : null}
        feedUrl={
          profile.calendarFeedToken && profile.onboardedAt
            ? `${origin}/api/calendar/feed/${profile.calendarFeedToken}.ics`
            : null
        }
        origin={origin}
        canEdit={canConfigure(scope)}
        widgetKey={profile.onboardedAt ? profile.widgetKey : ""}
      />
    </Page>
  );
}
