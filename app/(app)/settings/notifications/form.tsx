"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

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
        title="E-postvarsling"
        description={
          email
            ? `Sendes til ${email}. Vi bruker adressen du er logget inn med.`
            : "Sendes til adressen du er logget inn med."
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
          title="Påminnelser"
          description="Når Maya kommer tilbake til noe hun lovte å følge opp."
          defaultChecked={settings.reminders}
        />
        <Row
          name="backgroundDone"
          title="Ferdig bakgrunnsarbeid"
          description="Når noe hun jobbet med i bakgrunnen er ferdig."
          defaultChecked={settings.backgroundDone}
        />
        <Row
          name="approvalNeeded"
          title="Trenger godkjenning"
          description="Når hun har stoppet og venter på at du godkjenner et steg."
          defaultChecked={settings.approvalNeeded}
        />

        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Stille timer</p>
            <p className="text-muted-foreground text-sm">
              Varsler venter til stille-perioden er over. Ingenting blir borte.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor={startId} className="text-muted-foreground text-sm">
              Fra
            </label>
            <Input
              id={startId}
              name="quietHoursStart"
              type="time"
              defaultValue={settings.quietHoursStart}
              className="w-32"
            />
            <label htmlFor={endId} className="text-muted-foreground text-sm">
              til
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
              Tidssone
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
          {pending ? "Lagrer…" : "Lagre"}
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
