"use client"

import * as React from "react"

import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import { TeamSwitcher } from "@/components/team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"
import { TerminalSquareIcon, CalendarDaysIcon, ListTodoIcon, LayoutDashboardIcon } from "lucide-react"
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
        <NavUser
          user={user}
          plan={plan}
          notificationSettings={notificationSettings}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
