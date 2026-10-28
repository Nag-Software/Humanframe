"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  BarChart3Icon,
  FileTextIcon,
  HistoryIcon,
  InboxIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
} from "lucide-react"

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
import { LogoMark } from "@/components/hf/logo"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
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
  inboxWaiting = 0,
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
  /** Inquiries with something waiting for the owner. */
  inboxWaiting?: number
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
      <SidebarHeader className="gap-3 px-3 pt-4 pb-2">
        <Link href="/inbox" className="flex items-center gap-2.5 px-1 group-data-[collapsible=icon]:px-0">
          <LogoMark className="size-7 shrink-0" />
          <span className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
            <span className="font-serif text-[1.3rem] leading-none tracking-[-0.02em]">Humanframe</span>
            <span className="text-muted-foreground mt-1 truncate text-[11px]">
              {workspaceName} · {t.nav.plans[plan]}
            </span>
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t.receptionist.nav.work}</SidebarGroupLabel>
          <SidebarMenu className="gap-0.5">
            <NavLink href="/inbox" label={t.receptionist.nav.inbox} active={pathname.startsWith("/inbox")} icon={<InboxIcon />}>
              {inboxWaiting > 0 ? <SidebarMenuBadge className="bg-fjord text-fjord-foreground rounded-full px-1.5">{inboxWaiting}</SidebarMenuBadge> : null}
            </NavLink>
            <NavLink href="/quotes" label={t.receptionist.nav.quotes} active={pathname.startsWith("/quotes")} icon={<FileTextIcon />} />
            <NavLink href="/reports" label={t.receptionist.nav.reports} active={pathname.startsWith("/reports")} icon={<BarChart3Icon />} />
            <NavLink href="/setup" label={t.receptionist.nav.setup} active={pathname.startsWith("/setup")} icon={<SlidersHorizontalIcon />} />
          </SidebarMenu>
        </SidebarGroup>
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

function NavLink({
  href,
  label,
  active,
  icon,
  children,
}: {
  href: string
  label: string
  active: boolean
  icon: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={label}
        isActive={active}
        className="h-9 data-active:bg-card data-active:shadow-hairline data-active:font-medium"
        render={<Link href={href} />}
      >
        {icon}
        <span>{label}</span>
      </SidebarMenuButton>
      {children}
    </SidebarMenuItem>
  )
}
