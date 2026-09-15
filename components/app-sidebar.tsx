"use client"

import * as React from "react"

import { NavMain } from "@/components/nav-main"
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
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"
import {
  CalendarDaysIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  Settings2Icon,
  TerminalSquareIcon,
} from "lucide-react"
import Image from "next/image"

import { useTranslations } from "@/components/i18n-provider"
import type { NotificationSettingsValues } from "@/lib/settings/notification-settings"
import { DEFAULT_PLAN, type PlanId } from "@/lib/subscription"

export function AppSidebar({
  user,
  plan = DEFAULT_PLAN,
  notificationSettings,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; avatar: string }
  plan?: PlanId
  notificationSettings: NotificationSettingsValues
}) {
  const t = useTranslations()
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

  const navMain = [
    {
      title: t.nav.overview,
      url: "/",
      icon: <LayoutDashboardIcon />,
    },
    {
      title: t.nav.assistants,
      url: "/assistants",
      icon: <TerminalSquareIcon />,
      isActive: true,
      items: [
        {
          title: t.nav.maya,
          url: "/assistants/maya",
        },
      ],
    },
    {
      title: t.nav.routineTasks,
      url: "/routine-tasks",
      icon: <ListTodoIcon />,
    },
    {
      title: t.nav.calendar,
      url: "/calendar",
      icon: <CalendarDaysIcon />,
    },
    {
      title: t.nav.settings,
      icon: <Settings2Icon />,
      isActive: settingsOpen,
      onClick: () => openSettings(),
    },
  ]

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher
          teams={[
            {
              name: "Humanframe",
              logo: (
                <Image
                  src="/icon.png"
                  alt="Humanframe"
                  width={64}
                  height={64}
                  className="size-8 bg-white"
                />
              ),
              plan: t.nav.plans[plan],
            },
          ]}
        />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} label={t.nav.platform} />
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
      />
    </Sidebar>
  )
}
