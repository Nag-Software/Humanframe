"use client"

import Image from "next/image"
import { PlusIcon } from "lucide-react"

import { useLocale, useTranslations } from "@/components/i18n-provider"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { formatWhen } from "@/lib/i18n/format"

/**
 * One row per colleague. Maya is the only one today; the row shape is what a
 * second digital employee will reuse, so nothing here is named after her.
 */
export type Colleague = {
  slug: string
  name: string
  avatar: string
  href: string
  /** The last thing said between you, or the title of the latest conversation. */
  lastLine: string | null
  lastAt: string | null
}

export function NavTeam({
  colleagues,
  activeSlug,
}: {
  colleagues: Colleague[]
  activeSlug: string | null
}) {
  const t = useTranslations()
  const locale = useLocale()

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t.nav.team}</SidebarGroupLabel>
      <SidebarMenu>
        {colleagues.map((colleague) => (
          <SidebarMenuItem key={colleague.slug}>
            <SidebarMenuButton
              size="lg"
              isActive={colleague.slug === activeSlug}
              tooltip={colleague.name}
              render={<a href={colleague.href} />}
            >
              <Image
                src={colleague.avatar}
                alt=""
                width={32}
                height={32}
                className="size-8 shrink-0 rounded-full object-cover"
              />
              <div className="grid min-w-0 flex-1 leading-tight">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {colleague.name}
                  </span>
                  {colleague.lastAt ? (
                    <span
                      suppressHydrationWarning
                      className="text-muted-foreground shrink-0 text-[11px] tabular-nums"
                    >
                      {formatWhen(colleague.lastAt, locale)}
                    </span>
                  ) : null}
                </div>
                <span className="text-muted-foreground truncate text-xs">
                  {colleague.lastLine ?? t.maya.here}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}

        <SidebarMenuItem>
          <SidebarMenuButton
            size="lg"
            tooltip={t.nav.addColleague}
            disabled
            className="text-muted-foreground h-10 disabled:opacity-100"
            render={<button type="button" />}
          >
            <span className="border-border flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed">
              <PlusIcon className="size-3.5" />
            </span>
            <span className="text-sm">{t.nav.addColleague}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  )
}
