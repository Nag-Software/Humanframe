"use client"

import { useEffect, useState } from "react"

import { useTranslations } from "@/components/i18n-provider"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import type {
  ActivityStatus,
  LiveActivity,
} from "@/server/db/repositories/activity"

/** How often the list refreshes while the tab is visible. */
const POLL_MS = 15_000

/**
 * What she is doing right now. The sidebar is not a log: finished work is
 * on the Log page, and what she is holding is on her profile. This is only
 * the live part — running, queued, or waiting on you.
 */
export function NavActivity({
  initial,
  conversationHref,
}: {
  initial: LiveActivity[]
  conversationHref: string
}) {
  const t = useTranslations()
  const [items, setItems] = useState(initial)

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      if (document.visibilityState !== "visible") {
        return
      }
      try {
        const response = await fetch("/api/assistants/maya/activity", {
          cache: "no-store",
        })
        if (!response.ok) {
          return
        }
        const body = (await response.json()) as { items: LiveActivity[] }
        if (!cancelled) {
          setItems(body.items)
        }
      } catch {
        // A missed poll is not an error the user needs; the next one will land.
      }
    }
    const timer = setInterval(refresh, POLL_MS)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [])

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>{t.nav.now}</SidebarGroupLabel>
      <SidebarMenu>
        {items.length === 0 ? (
          <SidebarMenuItem>
            <p className="text-muted-foreground px-2 py-1.5 text-[13px]">
              {t.maya.activity.empty}
            </p>
          </SidebarMenuItem>
        ) : (
          items.map((item) => (
            <SidebarMenuItem key={`${item.kind}:${item.id}`}>
              <SidebarMenuButton
                size="lg"
                render={<a href={`${conversationHref}?t=${item.threadId}`} />}
              >
                <StatusDot status={item.status} />
                <div className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate text-[13px] font-medium">
                    {item.title}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {statusLabel(item.status, t.maya.activity)}
                  </span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}

function StatusDot({ status }: { status: ActivityStatus }) {
  const active =
    status === "running" || status === "in_progress" || status === "waking"
  const attention = status === "waiting_approval" || status === "waiting_input"
  return (
    <span className="flex size-8 shrink-0 items-center justify-center">
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          active && "bg-emerald-500 animate-pulse",
          attention && "bg-amber-500",
          !active && !attention && "bg-muted-foreground/40"
        )}
      />
    </span>
  )
}

type Labels = ReturnType<typeof useTranslations>["maya"]["activity"]

function statusLabel(status: ActivityStatus, labels: Labels): string {
  switch (status) {
    case "queued":
      return labels.queued
    case "running":
      return labels.running
    case "waiting_input":
      return labels.waitingInput
    case "waiting_approval":
      return labels.waitingApproval
    case "waking":
      return labels.waking
    case "in_progress":
      return labels.inProgress
  }
}
