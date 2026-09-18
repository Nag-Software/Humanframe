"use client"

import { Fragment } from "react"
import {
  BadgeCheckIcon,
  BellIcon,
  CreditCardIcon,
  GaugeIcon,
  LinkIcon,
  SparklesIcon,
} from "lucide-react"

import { ConnectorStatus } from "@/components/connector-status"
import { useTranslations } from "@/components/i18n-provider"
import { LanguageSwitcher } from "@/components/language-switcher"
import { NotificationSettingsForm } from "@/components/notification-settings-form"
import { UsageSettingsForm } from "@/components/usage-settings-form"
import { BillingPanel } from "@/components/billing-panel"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { UsageSettings, UsageSummary } from "@/lib/plans"
import type { SubscriptionSummary } from "@/server/billing/subscriptions"
import type { NotificationSettingsValues } from "@/lib/settings/notification-settings"
import { DEFAULT_PLAN, type PlanId } from "@/lib/subscription"

export const SETTINGS_TABS = [
  { id: "upgrade", icon: SparklesIcon },
  { id: "account", icon: BadgeCheckIcon },
  { id: "billing", icon: CreditCardIcon },
  { id: "usage", icon: GaugeIcon },
  { id: "notifications", icon: BellIcon },
  { id: "connections", icon: LinkIcon },
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"]

export const SETTINGS_NAV = [
  { items: [SETTINGS_TABS[0]] },
  { items: [SETTINGS_TABS[1], SETTINGS_TABS[2], SETTINGS_TABS[3], SETTINGS_TABS[4], SETTINGS_TABS[5]] },
] as const

export const SETTINGS_QUERY = "settings"

export function isSettingsTabId(
  value: string | null | undefined
): value is SettingsTabId {
  return SETTINGS_TABS.some((item) => item.id === value)
}

export type SettingsUser = {
  name: string
  email: string
  avatar: string
}

export function SettingsDialog({
  open,
  onOpenChange,
  tab,
  onTabChange,
  user,
  plan = DEFAULT_PLAN,
  notificationSettings,
  usage,
  usageSettings,
  billing,
  billingEnabled,
  canManageBilling,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tab: SettingsTabId
  onTabChange: (tab: SettingsTabId) => void
  user: SettingsUser
  plan?: PlanId
  notificationSettings: NotificationSettingsValues
  usage: UsageSummary
  usageSettings: UsageSettings
  billing: SubscriptionSummary
  billingEnabled: boolean
  canManageBilling: boolean
}) {
  const t = useTranslations()
  const activeTab = SETTINGS_TABS.find((item) => item.id === tab) ?? SETTINGS_TABS[0]
  const ActiveIcon = activeTab.icon
  const tabTitle = t.nav[activeTab.id]

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => onOpenChange(nextOpen)}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[min(720px,85vh)] md:max-w-[700px] lg:max-w-[800px]">
        <DialogTitle className="sr-only">{t.settings.title}</DialogTitle>
        <DialogDescription className="sr-only">
          {t.settings.description}
        </DialogDescription>
        <SidebarProvider className="items-start">
          <Sidebar collapsible="none" className="hidden md:flex">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  {SETTINGS_NAV.map((group, index) => (
                    <Fragment key={group.items.map((item) => item.id).join("-")}>
                      {index > 0 ? (
                        <SidebarSeparator className="my-1" />
                      ) : null}
                      <SidebarMenu>
                        {group.items.map((item) => {
                          const Icon = item.icon
                          return (
                            <SidebarMenuItem key={item.id}>
                              <SidebarMenuButton
                                isActive={item.id === activeTab.id}
                                onClick={() => onTabChange(item.id)}
                              >
                                <Icon />
                                <span>{t.nav[item.id]}</span>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          )
                        })}
                      </SidebarMenu>
                    </Fragment>
                  ))}
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <main className="flex h-[min(640px,85vh)] flex-1 flex-col overflow-hidden">
            <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-4 md:overflow-visible">
                <div className="flex gap-1 md:hidden">
                  {SETTINGS_TABS.map((item) => {
                    const Icon = item.icon
                    const selected = item.id === activeTab.id
                    return (
                      <Button
                        key={item.id}
                        size="sm"
                        variant={selected ? "secondary" : "ghost"}
                        aria-current={selected ? "page" : undefined}
                        onClick={() => onTabChange(item.id)}
                      >
                        <Icon />
                        <span>{t.nav[item.id]}</span>
                      </Button>
                    )
                  })}
                </div>
                <Breadcrumb className="hidden md:block">
                  <BreadcrumbList>
                    <BreadcrumbItem>
                      <span className="text-muted-foreground">
                        {t.settings.title}
                      </span>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage className="flex items-center gap-2">
                        <ActiveIcon className="size-4" />
                        {tabTitle}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
              </div>
            </header>
            <div className="flex flex-1 flex-col overflow-y-auto p-4 pt-0">
              <SettingsTabContent
                tab={activeTab.id}
                user={user}
                plan={plan}
                t={t}
                notificationSettings={notificationSettings}
                usage={usage}
                usageSettings={usageSettings}
                billing={billing}
                billingEnabled={billingEnabled}
                canManageBilling={canManageBilling}
              />
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}

function SettingsTabContent({
  tab,
  user,
  plan,
  t,
  notificationSettings,
  usage,
  usageSettings,
  billing,
  billingEnabled,
  canManageBilling,
}: {
  tab: SettingsTabId
  user: SettingsUser
  plan: PlanId
  t: Dictionary
  notificationSettings: NotificationSettingsValues
  usage: UsageSummary
  usageSettings: UsageSettings
  billing: SubscriptionSummary
  billingEnabled: boolean
  canManageBilling: boolean
}) {
  if (tab === "upgrade" || tab === "billing") {
    return (
      <section className="flex flex-col gap-4">
        <TabIntro
          title={tab === "upgrade" ? t.nav.upgrade : t.nav.billing}
          description={t.settings.billing.description}
        />
        <BillingPanel
          billing={billing}
          enabled={billingEnabled}
          canManage={canManageBilling}
        />
      </section>
    )
  }
  if (tab === "account") {
    return <AccountPanel user={user} t={t} />
  }
  if (tab === "connections") {
    return <ConnectionsPanel />
  }
  if (tab === "usage") {
    return (
      <section className="flex flex-col gap-4">
        <TabIntro title={t.nav.usage} description={t.settings.usage.description} />
        <UsageSettingsForm
          usage={usage}
          settings={usageSettings}
          planName={t.nav.plans[plan]}
        />
      </section>
    )
  }
  return (
    <NotificationsPanel
      t={t}
      settings={notificationSettings}
      email={user.email}
    />
  )
}

function AccountPanel({
  user,
  t,
}: {
  user: SettingsUser
  t: Dictionary
}) {
  const copy = t.settings.account
  const fields = [
    { label: copy.name, value: user.name },
    { label: copy.email, value: user.email },
  ]

  return (
    <section className="flex flex-col gap-4">
      <TabIntro title={t.nav.account} description={copy.description} />
      <dl className="space-y-3">
        {fields.map((field) => (
          <div
            key={field.label}
            className="flex items-center justify-between gap-4 rounded-xl border border-border/60 p-4"
          >
            <dt className="text-muted-foreground text-sm">{field.label}</dt>
            <dd className="truncate text-sm font-medium">{field.value}</dd>
          </div>
        ))}
      </dl>
      <LanguageSwitcher />
    </section>
  )
}

function NotificationsPanel({
  t,
  settings,
  email,
}: {
  t: Dictionary
  settings: NotificationSettingsValues
  email: string
}) {
  const copy = t.settings.notifications

  return (
    <section className="flex flex-col gap-4">
      <TabIntro title={t.nav.notifications} description={copy.description} />
      <NotificationSettingsForm settings={settings} email={email} />
    </section>
  )
}

function TabIntro({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="space-y-1">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  )
}

function ConnectionsPanel() {
  return (
    <section className="flex flex-col gap-4">
      <ConnectorStatus />
    </section>
  )
}
