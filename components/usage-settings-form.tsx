"use client";

import { useActionState, useId, useState } from "react";

import { useLocale, useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatMessage, intlLocales } from "@/lib/i18n/dictionaries";
import { formatLongDate } from "@/lib/i18n/format";
import {
  OVERAGE_USD_PER_MINUTE,
  type KindUsage,
  type UsageSettings,
  type UsageSummary,
} from "@/lib/plans";
import {
  saveUsageSettings,
  type UsageFormState,
} from "@/lib/settings/usage-actions";
import { cn } from "@/lib/utils";

const INITIAL: UsageFormState = { ok: true };

/**
 * The usage panel: two meters, the money beyond the plan, and the one
 * decision that matters — whether Maya may go beyond it at all.
 */
export function UsageSettingsForm({
  usage,
  settings,
  planName,
}: {
  usage: UsageSummary;
  settings: UsageSettings;
  planName: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const copy = t.settings.usage;
  const [state, action, pending] = useActionState(saveUsageSettings, INITIAL);
  const [allowOverage, setAllowOverage] = useState(settings.allowOverage);
  const allowId = useId();
  const capId = useId();

  const money = new Intl.NumberFormat(intlLocales[locale], {
    style: "currency",
    currency: "USD",
  });

  return (
    <form action={action} className="space-y-6">
      <div className="border-border/60 flex items-center justify-between rounded-xl border p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">{planName}</p>
          <p className="text-muted-foreground text-sm">
            {formatMessage(copy.period, {
              date: formatLongDate(usage.periodEnd, locale),
            })}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Meter label={copy.calls} usage={usage.voice} />
        <Meter label={copy.facetime} usage={usage.video} />
      </div>

      <div
        className={cn(
          "rounded-xl border p-4",
          usage.overageUsd > 0
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-border/60"
        )}
      >
        <p className="text-sm font-medium">{copy.overageTitle}</p>
        {usage.overageUsd > 0 ? (
          <p className="font-display mt-1 text-3xl font-semibold tracking-tight tabular-nums">
            {money.format(usage.overageUsd)}
          </p>
        ) : (
          <p className="text-muted-foreground mt-1 text-sm">{copy.overageNone}</p>
        )}
        <p className="text-muted-foreground mt-2 text-xs">
          {formatMessage(copy.ratesNote, {
            voice: money.format(OVERAGE_USD_PER_MINUTE.voice),
            video: money.format(OVERAGE_USD_PER_MINUTE.video),
          })}
        </p>
      </div>

      <div className="border-border/60 flex items-start justify-between gap-6 rounded-xl border p-4">
        <div className="space-y-1">
          <label htmlFor={allowId} className="text-sm font-medium">
            {copy.allowTitle}
          </label>
          <p className="text-muted-foreground text-sm">{copy.allowDescription}</p>
        </div>
        <Switch
          id={allowId}
          name="allowOverage"
          checked={allowOverage}
          onCheckedChange={setAllowOverage}
        />
      </div>

      <fieldset
        disabled={!allowOverage}
        className="border-border/60 flex items-start justify-between gap-6 rounded-xl border p-4 transition-opacity disabled:opacity-50"
      >
        <div className="space-y-1">
          <label htmlFor={capId} className="text-sm font-medium">
            {copy.capTitle}
          </label>
          <p className="text-muted-foreground text-sm">{copy.capDescription}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">$</span>
          <Input
            id={capId}
            name="overageCapUsd"
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            placeholder={copy.capPlaceholder}
            defaultValue={settings.overageCapUsd ?? ""}
            className="w-28"
          />
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t.common.saving : t.common.save}
        </Button>
        {state.message ? (
          <p
            role="status"
            className={cn(
              "text-sm",
              state.ok ? "text-muted-foreground" : "text-destructive"
            )}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function Meter({ label, usage }: { label: string; usage: KindUsage }) {
  const t = useTranslations();
  const copy = t.settings.usage;
  const used = Math.round(usage.usedSeconds / 60);
  const included = Math.round(usage.includedSeconds / 60);
  const ratio = included > 0 ? Math.min(1, usage.usedSeconds / usage.includedSeconds) : 1;
  const beyond = Math.ceil(usage.overageSeconds / 60);

  return (
    <div className="border-border/60 space-y-3 rounded-xl border p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-muted-foreground text-sm tabular-nums">
          {formatMessage(copy.ofIncluded, { used, included })}
        </p>
      </div>
      <div className="bg-muted h-1.5 overflow-hidden rounded-full">
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            beyond > 0 ? "bg-amber-500" : "bg-foreground"
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      {beyond > 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {formatMessage(copy.beyond, { minutes: beyond })}
        </p>
      ) : null}
    </div>
  );
}
