"use client"

import * as React from "react"
import Image from "next/image"
import { usePathname } from "next/navigation"
import { HistoryIcon, Settings2Icon } from "lucide-react"

import { useTranslations } from "@/components/i18n-provider"
import { NavActivity } from "@/components/nav-activity"
import { NavTeam, type Colleague } from "@/components/nav-team"
import { NavUser } from "@/components/nav-user"
import {
  SETTINGS_QUERY,
  SettingsDialog,
  isSettingsTabId,
  type SettingsTabId,
} from "@/components/settings-dialog"
import { TeamSwitcher } from "@/components/team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import type { UsageSettings, UsageSummary } from "@/lib/plans"
import type { SubscriptionSummary } from "@/server/billing/subscriptions"
import type { NotificationSettingsValues } from "@/lib/settings/notification-settings"
import { DEFAULT_PLAN, type PlanId } from "@/lib/subscription"
import type { LiveActivity } from "@/server/db/repositories/activity"

/**
 * The sidebar is a list of people and what they are doing, not a module
 * tree. Maya is the first row of the team; under her is what she is working
 * on right now. The log and settings sit at the bottom; the user in the
 * footer, as before.
 */
export function AppSidebar({
  user,
  plan = DEFAULT_PLAN,
  notificationSettings,
  workspaceName,
  colleagues,
  activity,
  usage,
  usageSettings,
  billing,
  billingEnabled,
  canManageBilling,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; avatar: string }
  plan?: PlanId
  notificationSettings: NotificationSettingsValues
  workspaceName: string
  colleagues: Colleague[]
  activity: LiveActivity[]
  usage: UsageSummary
  usageSettings: UsageSettings
  billing: SubscriptionSummary
  billingEnabled: boolean
  canManageBilling: boolean
}) {
  const t = useTranslations()
  const pathname = usePathname()
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [settingsTab, setSettingsTab] =
    React.useState<SettingsTabId>("account")

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const tab = params.get(SETTINGS_QUERY)
    if (!isSettingsTabId(tab)) {
      return
    }
    // Query is only readable after hydration; opening during render would
    // mismatch the server HTML.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URL after mount
    setSettingsTab(tab)
    setSettingsOpen(true)
    params.delete(SETTINGS_QUERY)
    const query = params.toString()
    const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
    window.history.replaceState(null, "", next)
  }, [])

  function openSettings(tab: SettingsTabId = "account") {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  const maya = colleagues[0]
  const logHref = maya ? `${maya.href}/log` : "/assistants/maya/log"

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher
          teams={[
            {
              name: workspaceName,
              logo: (
                <Image
                  src="/icon.png"
                  alt=""
                  width={64}
                  height={64}
                  className="size-auto bg-white"
                />
              ),
              plan: t.nav.plans[plan],
            },
          ]}
        />
      </SidebarHeader>
      <SidebarContent>
        <NavTeam colleagues={colleagues} activeSlug={maya?.slug ?? null} />
        {maya ? (
          <NavActivity initial={activity} conversationHref={maya.href} />
        ) : null}
        <SidebarGroup className="mt-auto">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={t.nav.log}
                isActive={pathname === logHref}
                render={<a href={logHref} />}
              >
                <HistoryIcon />
                <span>{t.nav.log}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={t.nav.settings}
                isActive={settingsOpen}
                render={<button type="button" onClick={() => openSettings()} />}
              >
                <Settings2Icon />
                <span>{t.nav.settings}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} onOpenSettings={openSettings} />
      </SidebarFooter>
      <SidebarRail />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        tab={settingsTab}
        onTabChange={setSettingsTab}
        user={user}
        plan={plan}
        notificationSettings={notificationSettings}
        usage={usage}
        usageSettings={usageSettings}
        billing={billing}
        billingEnabled={billingEnabled}
        canManageBilling={canManageBilling}
      />
    </Sidebar>
  )
}
