"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarIcon, CheckIcon, MessageSquareIcon, PhoneIcon, SendIcon } from "lucide-react";

import { useLocale, useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatMessage } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/utils";

import { formatInZone, formatPhone, fromLocalInput, toLocalInput } from "./format";

export type ActionView = {
  id: string;
  kind: "booking" | "sms" | "reply" | "callback";
  status: "proposed" | "approved" | "executing" | "done" | "failed" | "unknown" | "dismissed";
  payload: Record<string, unknown>;
  rationale: string;
  error: string | null;
};

const ICONS = {
  booking: CalendarIcon,
  sms: MessageSquareIcon,
  reply: SendIcon,
  callback: PhoneIcon,
} as const;

/**
 * One proposal and its one tap. The owner can edit the text or the time
 * first; what they approve is what runs.
 */
export function ActionCard({ action, timeZone }: { action: ActionView; timeZone: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const copy = t.receptionist.action;
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(action.status === "failed" || action.status === "unknown" ? action.error : null);
  const [clash, setClash] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(action.payload);

  const open = action.status === "proposed" || action.status === "failed";
  const Icon = ICONS[action.kind];

  async function decide(decision: "approve" | "dismiss", force = false) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/receptionist/actions/${action.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          decision === "dismiss" ? { decision } : { decision, payload: draft, force }
        ),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!response.ok) {
        if (body.error === "clash") {
          setClash(true);
        } else if (body.error === "already_decided") {
          setError(copy.alreadyDecided);
        } else {
          setError(body.message ?? copy.failedGeneric);
        }
        return;
      }
      setClash(false);
      setEditing(false);
      router.refresh();
    } catch {
      setError(copy.failedGeneric);
    } finally {
      setBusy(false);
    }
  }

  const approveLabel =
    action.kind === "booking"
      ? copy.approveBooking
      : action.kind === "callback"
        ? copy.approveCallback
        : copy.approveSend;

  return (
    <div
      className={cn(
        "border-border/60 flex flex-col gap-3 rounded-xl border p-4",
        !open && "bg-muted/30"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="text-muted-foreground size-4" />
          <p className="text-sm font-medium">{copy.kind[action.kind]}</p>
        </div>
        <span
          className={cn(
            "text-xs",
            action.status === "done" ? "text-emerald-600" : action.status === "failed" || action.status === "unknown" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {action.status === "done" ? <CheckIcon className="mr-1 inline size-3" /> : null}
          {copy.status[action.status]}
        </span>
      </div>

      {action.rationale ? <p className="text-muted-foreground text-sm">{action.rationale}</p> : null}

      {editing ? (
        <EditFields action={action} draft={draft} setDraft={setDraft} timeZone={timeZone} />
      ) : (
        <Summary action={action} payload={draft} timeZone={timeZone} locale={locale} />
      )}

      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          {clash ? (
            <>
              <span className="text-sm">{copy.clash}</span>
              <Button size="sm" disabled={busy} onClick={() => void decide("approve", true)}>
                {copy.bookAnyway}
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>
              {busy ? copy.working : approveLabel}
            </Button>
          )}
          {action.kind !== "callback" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing((value) => !value)}>
              {editing ? copy.cancelEdit : copy.edit}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide("dismiss")}>
            {copy.dismiss}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Summary({
  action,
  payload,
  timeZone,
  locale,
}: {
  action: ActionView;
  payload: Record<string, unknown>;
  timeZone: string;
  locale: "en" | "no";
}) {
  const t = useTranslations();
  const copy = t.receptionist.action;
  const text = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : "");

  if (action.kind === "booking") {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-medium">
          {text("startsAt") ? formatInZone(text("startsAt"), timeZone, locale) : ""}
          {text("endsAt") ? `–${formatInZone(text("endsAt"), timeZone, locale, "time")}` : ""}
        </p>
        <p>{text("title")}</p>
        {text("address") ? <p className="text-muted-foreground">{text("address")}</p> : null}
        {text("confirmationSms") ? (
          <p className="bg-muted/60 mt-1 rounded-lg px-3 py-2 whitespace-pre-line">
            <span className="text-muted-foreground block text-xs">
              {copy.confirmation} · {formatPhone(text("customerPhone"))}
            </span>
            {text("confirmationSms")}
          </p>
        ) : null}
      </div>
    );
  }

  if (action.kind === "callback") {
    return (
      <a href={`tel:${text("phone")}`} className="text-sm font-medium underline underline-offset-4">
        {formatPhone(text("phone"))}
      </a>
    );
  }

  return (
    <div className="bg-muted/60 rounded-lg px-3 py-2 text-sm whitespace-pre-line">
      <span className="text-muted-foreground block text-xs">
        {copy.to} {formatPhone(text("to"))}
      </span>
      {text("body")}
    </div>
  );
}

function EditFields({
  action,
  draft,
  setDraft,
  timeZone,
}: {
  action: ActionView;
  draft: Record<string, unknown>;
  setDraft: (value: Record<string, unknown>) => void;
  timeZone: string;
}) {
  const t = useTranslations();
  const copy = t.receptionist.action;
  const text = (key: string) => (typeof draft[key] === "string" ? (draft[key] as string) : "");
  const set = (key: string, value: unknown) => setDraft({ ...draft, [key]: value });

  if (action.kind === "booking") {
    const startsAt = text("startsAt");
    const endsAt = text("endsAt");
    const minutes =
      startsAt && endsAt ? Math.max(10, Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000)) : 60;
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={copy.start}>
          <Input
            type="datetime-local"
            value={startsAt ? toLocalInput(startsAt, timeZone) : ""}
            onChange={(event) => {
              const iso = fromLocalInput(event.target.value, timeZone);
              if (!iso) return;
              setDraft({
                ...draft,
                startsAt: iso,
                endsAt: new Date(Date.parse(iso) + minutes * 60_000).toISOString(),
              });
            }}
          />
        </Field>
        <Field label={copy.end}>
          <Input
            type="datetime-local"
            value={endsAt ? toLocalInput(endsAt, timeZone) : ""}
            onChange={(event) => {
              const iso = fromLocalInput(event.target.value, timeZone);
              if (iso) set("endsAt", iso);
            }}
          />
        </Field>
        <Field label={copy.title} wide>
          <Input value={text("title")} onChange={(event) => set("title", event.target.value)} />
        </Field>
        <Field label={copy.address} wide>
          <Input value={text("address")} onChange={(event) => set("address", event.target.value)} />
        </Field>
        <Field label={copy.confirmation} wide>
          <Textarea
            value={text("confirmationSms")}
            placeholder={copy.noConfirmation}
            onChange={(event) => set("confirmationSms", event.target.value.trim() ? event.target.value : null)}
          />
        </Field>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <Field label={copy.to}>
        <Input value={text("to")} onChange={(event) => set("to", event.target.value)} />
      </Field>
      <Field label={copy.message}>
        <Textarea rows={4} value={text("body")} onChange={(event) => set("body", event.target.value)} />
      </Field>
      {draft.includeUploadLink ? (
        <p className="text-muted-foreground text-xs">{formatMessage(copy.uploadLinkNote, { link: "{lenke}" })}</p>
      ) : null}
    </div>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={cn("flex flex-col gap-1.5", wide && "sm:col-span-2")}>
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}
