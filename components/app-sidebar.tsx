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
import { TerminalSquareIcon, Settings2Icon, CalendarDaysIcon, ListTodoIcon, LayoutDashboardIcon } from "lucide-react"
import Image from "next/image"

import { useTranslations } from "@/components/i18n-provider"
import { DEFAULT_PLAN, type PlanId } from "@/lib/subscription"

// Navigation is static. User comes from the session.
const data = {
  navMain: [
    {
      title: "Overview",
      url: "/",
      icon: (
        <LayoutDashboardIcon
        />
      ),
    },
    {
      title: "Assistants",
      url: "/assistants",
      icon: (
        <TerminalSquareIcon
        />
      ),
      isActive: true,
      items: [
        {
          title: "Maya",
          url: "/assistants/maya",
        }
      ],
    },
    {
      title: "Routine tasks",
      url: "/routine-tasks",
      icon: (
        <ListTodoIcon
        />
      ),
    },
    {
      title: "Calendar",
      url: "/calendar",
      icon: (
        <CalendarDaysIcon
        />
      )
    },
    {
      title: "Settings",
      url: "/settings",
      icon: (
        <Settings2Icon
        />
      ),
      items: [
        {
          title: "General",
          url: "/settings/general",
        },
        {
          title: "Team",
          url: "/settings/team",
        },
        {
          title: "Billing",
          url: "/settings/billing",
        },
        {
          title: "Limits",
          url: "/settings/limits",
        },
      ],
    },
  ]
}

export function AppSidebar({
  user,
  plan = DEFAULT_PLAN,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; avatar: string }
  plan?: PlanId
}) {
  const t = useTranslations()

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
        <NavMain items={data.navMain} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} plan={plan} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
