import type { Metadata } from "next";

import { appOrigin } from "@/agent/lib/email-template";
import { SetupForm } from "@/components/receptionist/setup-form";
import { SidebarTrigger } from "@/components/ui/sidebar";
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
    <div className="flex h-svh flex-col">
      <div className="flex h-16 shrink-0 items-center gap-1 px-3">
        <SidebarTrigger className="text-muted-foreground" />
        <h1 className="font-display px-1.5 text-base font-semibold tracking-tight">{copy.title}</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-24">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8">
          <p className="text-muted-foreground text-sm">{copy.description}</p>
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
          />
        </div>
      </div>
    </div>
  );
}
