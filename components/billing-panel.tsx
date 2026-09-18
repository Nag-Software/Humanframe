"use client";

import { useState } from "react";
import { CheckIcon } from "lucide-react";

import { useLocale, useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { formatMessage, intlLocales } from "@/lib/i18n/dictionaries";
import { formatLongDate } from "@/lib/i18n/format";
import { PLANS, type PlanId } from "@/lib/plans";
import type { SubscriptionSummary } from "@/server/billing/subscriptions";
import { cn } from "@/lib/utils";

type Interval = "month" | "year";

/**
 * Billing: where the workspace stands with Stripe, and the way to change it.
 *
 * A workspace without a plan chooses one here and is sent to Checkout; one
 * with a plan manages it in Stripe's portal — plan changes, card, invoices,
 * cancelling — so there is exactly one place money is touched.
 */
export function BillingPanel({
  billing,
  enabled,
  canManage,
}: {
  billing: SubscriptionSummary;
  enabled: boolean;
  canManage: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const copy = t.settings.billing;
  const [interval, setInterval] = useState<Interval>("month");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const money = new Intl.NumberFormat(intlLocales[locale], {
    style: "currency",
    currency: "USD",
  });
  const subscribed =
    billing.status === "trialing" ||
    billing.status === "active" ||
    billing.status === "past_due";

  async function go(path: string, body?: unknown, key = path) {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!response.ok || !data?.url) {
        setError(data?.error === "already_subscribed" ? copy.alreadySubscribed : copy.failed);
        setBusy(null);
        return;
      }
      window.location.assign(data.url);
    } catch {
      setError(copy.failed);
      setBusy(null);
    }
  }

  const statusLine = (() => {
    switch (billing.status) {
      case "trialing":
        return billing.trialEnd
          ? formatMessage(copy.status.trialing, { date: formatLongDate(billing.trialEnd, locale) })
          : copy.status.trialingNoDate;
      case "active":
        return billing.cancelAtPeriodEnd && billing.currentPeriodEnd
          ? formatMessage(copy.status.ending, { date: formatLongDate(billing.currentPeriodEnd, locale) })
          : billing.currentPeriodEnd
            ? formatMessage(copy.status.renews, { date: formatLongDate(billing.currentPeriodEnd, locale) })
            : copy.status.active;
      case "past_due":
      case "unpaid":
        return copy.status.pastDue;
      case "canceled":
      case "incomplete_expired":
        return copy.status.canceled;
      case "incomplete":
        return copy.status.incomplete;
      case "paused":
        return copy.status.paused;
      default:
        return copy.status.none;
    }
  })();

  return (
    <div className="space-y-6">
      <div className="border-border/60 flex items-center justify-between gap-4 rounded-xl border p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {subscribed ? t.nav.plans[billing.plan] : copy.noPlan}
            {subscribed && billing.interval ? (
              <span className="text-muted-foreground font-normal">
                {" · "}
                {billing.interval === "year" ? copy.yearly : copy.monthly}
              </span>
            ) : null}
          </p>
          <p
            className={cn(
              "text-sm",
              billing.status === "past_due" || billing.status === "unpaid"
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground"
            )}
          >
            {statusLine}
          </p>
        </div>
        {enabled && billing.hasCustomer && canManage ? (
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() => void go("/api/billing/portal")}
          >
            {busy === "/api/billing/portal" ? copy.opening : copy.manage}
          </Button>
        ) : null}
      </div>

      {!enabled ? (
        <p className="text-muted-foreground text-sm">{copy.notEnabled}</p>
      ) : !canManage ? (
        <p className="text-muted-foreground text-sm">{copy.ownerOnly}</p>
      ) : subscribed ? (
        <p className="text-muted-foreground text-sm">{copy.changeInPortal}</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-1 rounded-full border border-border/60 p-1 w-fit">
            {(["month", "year"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setInterval(option)}
                className={cn(
                  "rounded-full px-3 py-1 text-[13px] font-medium transition-colors",
                  interval === option
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {option === "month" ? copy.monthly : copy.yearlyFree}
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {(["starter", "pro"] as const).map((planId) => (
              <PlanCard
                key={planId}
                planId={planId}
                interval={interval}
                money={money}
                busy={busy === planId}
                disabled={busy !== null}
                trial={billing.trialAvailable}
                onChoose={() =>
                  void go("/api/billing/checkout", { plan: planId, interval }, planId)
                }
              />
            ))}
          </div>

          <p className="text-muted-foreground text-xs">
            {billing.trialAvailable ? copy.trialNote : copy.noTrialNote}
          </p>
        </div>
      )}

      {error ? (
        <p role="status" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PlanCard({
  planId,
  interval,
  money,
  busy,
  disabled,
  trial,
  onChoose,
}: {
  planId: PlanId;
  interval: Interval;
  money: Intl.NumberFormat;
  busy: boolean;
  disabled: boolean;
  trial: boolean;
  onChoose: () => void;
}) {
  const t = useTranslations();
  const copy = t.settings.billing;
  const plan = PLANS[planId];
  const price = interval === "year" ? plan.yearlyMonthlyUsd : plan.monthlyUsd;
  const features = [
    formatMessage(copy.features.calls, { minutes: plan.includedMinutes.voice / 60 }),
    formatMessage(copy.features.facetime, { minutes: plan.includedMinutes.video }),
    copy.features.everything,
    ...(planId === "pro" ? [copy.features.proExtra] : []),
  ];

  return (
    <div
      className={cn(
        "border-border/60 flex flex-col gap-4 rounded-xl border p-4",
        planId === "pro" && "bg-muted/40"
      )}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{t.nav.plans[planId]}</p>
        <p className="font-display text-2xl font-semibold tracking-tight">
          {money.format(price)}
          <span className="text-muted-foreground text-sm font-normal"> {copy.perMonth}</span>
        </p>
      </div>
      <ul className="text-muted-foreground space-y-1.5 text-sm">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2">
            <CheckIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <Button
        className="mt-auto"
        variant={planId === "pro" ? "default" : "outline"}
        disabled={disabled}
        onClick={onChoose}
      >
        {busy ? copy.opening : trial ? copy.startTrial : copy.choose}
      </Button>
    </div>
  );
}
