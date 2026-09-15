"use client";

import { useActionState, useId, useState } from "react";

import { useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatMessage } from "@/lib/i18n/dictionaries";

import { saveNotificationSettings, type NotificationFormState } from "./actions";

export type NotificationSettingsValues = {
  emailEnabled: boolean;
  reminders: boolean;
  backgroundDone: boolean;
  approvalNeeded: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;
};

const INITIAL: NotificationFormState = { ok: true };

export function NotificationSettingsForm({
  settings,
  email,
}: {
  settings: NotificationSettingsValues;
  email: string | null;
}) {
  const t = useTranslations();
  const copy = t.settings.notifications.form;
  const [state, action, pending] = useActionState(
    saveNotificationSettings,
    INITIAL
  );
  const [emailEnabled, setEmailEnabled] = useState(settings.emailEnabled);
  const startId = useId();
  const endId = useId();
  const zoneId = useId();

  // The browser knows the zone; offering it saves the user typing an IANA name.
  const detectedZone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC";

  return (
    <form action={action} className="max-w-xl space-y-8">
      <Row
        name="emailEnabled"
        title={copy.emailTitle}
        description={
          email
            ? formatMessage(copy.emailDescriptionNamed, { email })
            : copy.emailDescription
        }
        checked={emailEnabled}
        onCheckedChange={setEmailEnabled}
      />

      <fieldset
        disabled={!emailEnabled}
        className="space-y-6 transition-opacity disabled:opacity-50"
      >
        <Row
          name="reminders"
          title={copy.remindersTitle}
          description={copy.remindersDescription}
          defaultChecked={settings.reminders}
        />
        <Row
          name="backgroundDone"
          title={copy.backgroundTitle}
          description={copy.backgroundDescription}
          defaultChecked={settings.backgroundDone}
        />
        <Row
          name="approvalNeeded"
          title={copy.approvalTitle}
          description={copy.approvalDescription}
          defaultChecked={settings.approvalNeeded}
        />

        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">{copy.quietHoursTitle}</p>
            <p className="text-muted-foreground text-sm">
              {copy.quietHoursDescription}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor={startId} className="text-muted-foreground text-sm">
              {copy.from}
            </label>
            <Input
              id={startId}
              name="quietHoursStart"
              type="time"
              defaultValue={settings.quietHoursStart}
              className="w-32"
            />
            <label htmlFor={endId} className="text-muted-foreground text-sm">
              {copy.to}
            </label>
            <Input
              id={endId}
              name="quietHoursEnd"
              type="time"
              defaultValue={settings.quietHoursEnd}
              className="w-32"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor={zoneId} className="text-muted-foreground text-sm">
              {copy.timezone}
            </label>
            <Input
              id={zoneId}
              name="timezone"
              defaultValue={settings.timezone || detectedZone}
              placeholder="Europe/Oslo"
              className="w-64"
            />
          </div>
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t.common.saving : t.common.save}
        </Button>
        {state.message ? (
          <p
            className={
              state.ok ? "text-muted-foreground text-sm" : "text-destructive text-sm"
            }
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function Row({
  name,
  title,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
}: {
  name: string;
  title: string;
  description: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <Switch
        name={name}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
