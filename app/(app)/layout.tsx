import { AppSidebar } from "@/components/app-sidebar";
import { serverEnv } from "@/lib/env";
import type { Colleague } from "@/components/nav-team";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { loadNotificationSettings } from "@/lib/settings/notification-settings";
import { loadUsageSettings } from "@/lib/settings/usage-settings";
import {
  billingPeriod,
  loadSubscription,
  summarize,
} from "@/server/billing/subscriptions";
import { loadUsageSummary } from "@/server/billing/usage";
import { listLiveActivity } from "@/server/db/repositories/activity";
import { getAssistantBySlug } from "@/server/db/repositories/assistants";
import { listThreads } from "@/server/db/repositories/threads";
import { requireRequestScope } from "@/server/db/request-scope";
import { Analytics } from "@vercel/analytics/next";

const MAYA_HREF = "/assistants/maya";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const scope = await requireRequestScope();
  const subscription = await loadSubscription(scope.client, scope.workspaceId);
  const [notificationSettings, assistant, usage, usageSettings] =
    await Promise.all([
      loadNotificationSettings(scope),
      getAssistantBySlug(scope.client, scope.workspaceId, "maya"),
      loadUsageSummary(scope.client, {
        workspaceId: scope.workspaceId,
        plan: scope.workspace.plan,
        period: billingPeriod(subscription) ?? undefined,
      }),
      loadUsageSettings(scope.client, scope.workspaceId),
    ]);
  const billing = summarize(
    subscription,
    scope.workspace.plan,
    scope.workspace.stripeCustomerId !== null
  );

  const [{ threads }, activity] = assistant
    ? await Promise.all([
        listThreads(scope, { limit: 1, assistantId: assistant.id }),
        listLiveActivity(scope.client, scope.workspaceId, assistant.id),
      ])
    : [{ threads: [] }, []];
  const latest = threads[0] ?? null;

  const colleagues: Colleague[] = [
    {
      slug: "maya",
      name: assistant?.name ?? "Maya",
      avatar: "/assistants/maya-avatar.png",
      href: MAYA_HREF,
      lastLine: latest?.title ?? null,
      lastAt: latest?.lastMessageAt ?? null,
    },
  ];

  return (
    <>
      <Analytics />
      <SidebarProvider>
        <AppSidebar
          user={{
            name: scope.userName ?? scope.email ?? "",
            email: scope.email ?? "",
            avatar: "",
          }}
          plan={scope.workspace.plan}
          notificationSettings={notificationSettings}
          workspaceName={scope.workspace.name}
          colleagues={colleagues}
          activity={activity}
          usage={usage}
          usageSettings={usageSettings}
          billing={billing}
          billingEnabled={serverEnv().BILLING_ENABLED === "true"}
          canManageBilling={scope.workspace.role !== "member"}
        />
        <SidebarInset className="min-w-0">{children}</SidebarInset>
      </SidebarProvider>
    </>
  );
}
