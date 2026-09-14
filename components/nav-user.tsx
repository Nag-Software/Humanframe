"use client"

import * as React from "react"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { ChevronsUpDownIcon, LogOutIcon } from "lucide-react"

import { useTranslations } from "@/components/i18n-provider"
import {
  SETTINGS_NAV,
  SettingsDialog,
  type SettingsTabId,
} from "@/components/settings-dialog"
import { DEFAULT_PLAN, type PlanId } from "@/lib/subscription"

export function NavUser({
  user,
  plan = DEFAULT_PLAN,
}: {
  user: {
    name: string
    email: string
    avatar: string
  }
  plan?: PlanId
}) {
  const { isMobile } = useSidebar()
  const t = useTranslations()
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [settingsTab, setSettingsTab] =
    React.useState<SettingsTabId>("account")
  const initials = (user.name || user.email || "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")

  function openSettings(tab: SettingsTabId) {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton size="lg" className="aria-expanded:bg-muted" />
              }
            >
              <Avatar>
                <AvatarImage src={user.avatar} alt={user.name} />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{user.name}</span>
                <span className="truncate text-xs">{user.email}</span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-fit"
              side={isMobile ? "bottom" : "right"}
              align="end"
              sideOffset={4}
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel className="p-0 font-normal">
                  <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                    <Avatar>
                      <AvatarImage src={user.avatar} alt={user.name} />
                      <AvatarFallback>{initials}</AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">{user.name}</span>
                      <span className="truncate text-xs">{user.email}</span>
                    </div>
                  </div>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              {SETTINGS_NAV.map((group) => (
                <React.Fragment key={group.items.map((item) => item.id).join("-")}>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    {group.items.map((item) => {
                      const Icon = item.icon
                      return (
                        <DropdownMenuItem
                          key={item.id}
                          onClick={() => openSettings(item.id)}
                        >
                          <Icon />
                          {t.nav[item.id]}
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuGroup>
                </React.Fragment>
              ))}
              <DropdownMenuSeparator />
              <form action="/auth/sign-out" method="post">
                <DropdownMenuItem
                  nativeButton
                  render={<button type="submit" className="w-full" />}
                >
                  <LogOutIcon
                  />
                  {t.auth.signOut}
                </DropdownMenuItem>
              </form>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => setSettingsOpen(open)}
        tab={settingsTab}
        onTabChange={setSettingsTab}
        user={user}
        plan={plan}
      />
    </>
  )
}
