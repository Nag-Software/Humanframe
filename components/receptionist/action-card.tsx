"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CalendarIcon,
  CheckIcon,
  FileTextIcon,
  MessageSquareIcon,
  PhoneIcon,
  PlusIcon,
  SendIcon,
  XIcon,
} from "lucide-react";

import { formatNok } from "@/components/hf/money";
import { Pill } from "@/components/hf/surface";
import { useLocale, useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { quoteTotals, type QuoteLine } from "@/server/receptionist/quotes";

import { formatInZone, formatPhone, fromLocalInput, toLocalInput } from "./format";

export type ActionView = {
  id: string;
  kind: "booking" | "sms" | "reply" | "callback" | "quote";
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
  quote: FileTextIcon,
} as const;

const UNITS = ["stk", "time", "m2", "lm", "fast"] as const;

/**
 * One proposal and its one tap. The owner can edit first; what they approve
 * is exactly what runs.
 */
export function ActionCard({
  action,
  timeZone,
  pricesIncludeVat,
}: {
  action: ActionView;
  timeZone: string;
  pricesIncludeVat: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const copy = t.receptionist.action;
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    action.status === "failed" || action.status === "unknown" ? action.error : null
  );
  const [clash, setClash] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(action.payload);

  const open = action.status === "proposed" || action.status === "failed";
  const Icon = ICONS[action.kind];
  const title = action.kind === "quote" ? copy.quoteKind : copy.kind[action.kind];

  async function decide(decision: "approve" | "dismiss", force = false) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/receptionist/actions/${action.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decision === "dismiss" ? { decision } : { decision, payload: draft, force }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!response.ok) {
        if (body.error === "clash") setClash(true);
        else if (body.error === "already_decided") setError(copy.alreadyDecided);
        else setError(body.message ?? copy.failedGeneric);
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
        : action.kind === "quote"
          ? copy.approveQuote
          : copy.approveSend;

  const statusTone =
    action.status === "done"
      ? "fjord"
      : action.status === "failed" || action.status === "unknown"
        ? "ember"
        : action.status === "dismissed"
          ? "quiet"
          : "neutral";

  return (
    <article
      className={cn(
        "bg-card shadow-hairline flex flex-col gap-4 rounded-2xl p-5 transition-opacity",
        !open && "opacity-80"
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-9 items-center justify-center rounded-xl",
              action.kind === "quote" ? "bg-brass-soft text-[color:oklch(0.48_0.09_72)] dark:text-brass" : "bg-fjord-soft text-fjord"
            )}
          >
            <Icon className="size-4" />
          </span>
          <div>
            <p className="text-[15px] font-semibold">{title}</p>
            {action.rationale ? <p className="text-muted-foreground text-[13px] leading-snug">{action.rationale}</p> : null}
          </div>
        </div>
        <Pill tone={statusTone}>
          {action.status === "done" ? <CheckIcon className="size-3" /> : null}
          {copy.status[action.status]}
        </Pill>
      </header>

      {editing ? (
        <EditFields action={action} draft={draft} setDraft={setDraft} timeZone={timeZone} pricesIncludeVat={pricesIncludeVat} />
      ) : (
        <Summary action={action} payload={draft} timeZone={timeZone} locale={locale} pricesIncludeVat={pricesIncludeVat} />
      )}

      {error ? <p className="bg-ember-soft text-ember rounded-lg px-3 py-2 text-sm">{error}</p> : null}

      {open ? (
        <footer className="flex flex-wrap items-center gap-2 border-t pt-4">
          {clash ? (
            <>
              <span className="text-sm">{copy.clash}</span>
              <Button size="sm" disabled={busy} onClick={() => void decide("approve", true)}>
                {copy.bookAnyway}
              </Button>
            </>
          ) : (
            <Button className="h-9 rounded-xl px-4" disabled={busy} onClick={() => void decide("approve")}>
              {busy ? copy.working : approveLabel}
            </Button>
          )}
          {action.kind !== "callback" ? (
            <Button variant="outline" className="h-9 rounded-xl" disabled={busy} onClick={() => setEditing((value) => !value)}>
              {editing ? copy.cancelEdit : copy.edit}
            </Button>
          ) : null}
          <Button variant="ghost" className="text-muted-foreground h-9 rounded-xl" disabled={busy} onClick={() => void decide("dismiss")}>
            {copy.dismiss}
          </Button>
          {action.kind === "sms" || action.kind === "reply" || action.kind === "quote" ? (
            <span className="text-muted-foreground ml-auto text-xs">{copy.portalNote}</span>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

function text(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === "string" ? (payload[key] as string) : "";
}

function linesOf(payload: Record<string, unknown>): QuoteLine[] {
  return Array.isArray(payload.lines) ? (payload.lines as QuoteLine[]) : [];
}

function Summary({
  action,
  payload,
  timeZone,
  locale,
  pricesIncludeVat,
}: {
  action: ActionView;
  payload: Record<string, unknown>;
  timeZone: string;
  locale: "en" | "no";
  pricesIncludeVat: boolean;
}) {
  const copy = useTranslations().receptionist.action;

  if (action.kind === "quote") {
    const lines = linesOf(payload);
    const totals = quoteTotals(lines, pricesIncludeVat);
    return (
      <div className="flex flex-col gap-3">
        <p className="font-serif text-xl leading-tight">{text(payload, "title")}</p>
        <div className="overflow-hidden rounded-xl border">
          {lines.map((line, index) => (
            <div key={index} className="flex items-baseline justify-between gap-4 border-b px-4 py-2.5 text-sm last:border-b-0">
              <span>
                {line.description}
                {line.unit === "fast" ? null : (
                  <span className="text-muted-foreground">
                    {" "}
                    · {line.quantity} {line.unit} × {formatNok(line.unitPrice)}
                  </span>
                )}
              </span>
              <span className="tabular shrink-0">{formatNok(line.quantity * line.unitPrice)}</span>
            </div>
          ))}
          <div className="bg-muted/50 flex items-baseline justify-between px-4 py-3">
            <span className="text-muted-foreground text-sm">
              {copy.total} {pricesIncludeVat ? copy.vatIncl : copy.vatExcl}
            </span>
            <span className="font-serif tabular text-2xl">{formatNok(pricesIncludeVat ? totals.total : totals.subtotal)}</span>
          </div>
        </div>
        {text(payload, "notes") ? <p className="text-muted-foreground text-sm">{text(payload, "notes")}</p> : null}
        <p className="text-muted-foreground text-xs">
          {[text(payload, "customerName"), text(payload, "customerEmail"), formatPhone(text(payload, "customerPhone"))]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
    );
  }

  if (action.kind === "booking") {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-serif text-xl leading-tight">
          {text(payload, "startsAt") ? formatInZone(text(payload, "startsAt"), timeZone, locale) : ""}
          {text(payload, "endsAt") ? `–${formatInZone(text(payload, "endsAt"), timeZone, locale, "time")}` : ""}
        </p>
        <p>{text(payload, "title")}</p>
        {text(payload, "address") ? <p className="text-muted-foreground">{text(payload, "address")}</p> : null}
        {text(payload, "confirmationSms") ? (
          <Bubble label={`${copy.confirmation} · ${formatPhone(text(payload, "customerPhone"))}`}>
            {text(payload, "confirmationSms")}
          </Bubble>
        ) : null}
      </div>
    );
  }

  if (action.kind === "callback") {
    return (
      <a
        href={`tel:${text(payload, "phone")}`}
        className="bg-fjord text-fjord-foreground flex w-fit items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"
      >
        <PhoneIcon className="size-4" />
        {formatPhone(text(payload, "phone"))}
      </a>
    );
  }

  return (
    <Bubble label={`${copy.to} ${formatPhone(text(payload, "to")) || text(payload, "email")}`}>{text(payload, "body")}</Bubble>
  );
}

function Bubble({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-muted/60 rounded-xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed whitespace-pre-line">
      <span className="text-muted-foreground mb-1 block text-xs">{label}</span>
      {children}
    </div>
  );
}

function EditFields({
  action,
  draft,
  setDraft,
  timeZone,
  pricesIncludeVat,
}: {
  action: ActionView;
  draft: Record<string, unknown>;
  setDraft: (value: Record<string, unknown>) => void;
  timeZone: string;
  pricesIncludeVat: boolean;
}) {
  const t = useTranslations();
  const copy = t.receptionist.action;
  const units = t.receptionist.setup.units;
  const set = (key: string, value: unknown) => setDraft({ ...draft, [key]: value });

  if (action.kind === "quote") {
    const lines = linesOf(draft);
    const totals = quoteTotals(lines, pricesIncludeVat);
    const setLine = (index: number, patch: Partial<QuoteLine>) =>
      set(
        "lines",
        lines.map((line, at) => (at === index ? { ...line, ...patch } : line))
      );
    return (
      <div className="flex flex-col gap-3">
        <Field label={copy.title}>
          <Input value={text(draft, "title")} onChange={(event) => set("title", event.target.value)} />
        </Field>
        <div className="flex flex-col gap-2">
          {lines.map((line, index) => (
            <div key={index} className="grid grid-cols-[1fr_4.5rem_5.5rem_6.5rem_auto] items-center gap-2">
              <Input aria-label={copy.line} value={line.description} onChange={(event) => setLine(index, { description: event.target.value })} />
              <Input
                aria-label={copy.qty}
                type="number"
                step="0.5"
                min="0"
                value={line.quantity}
                onChange={(event) => setLine(index, { quantity: Number(event.target.value) || 0 })}
              />
              <select
                aria-label={copy.unit}
                className="border-input bg-transparent h-8 rounded-lg border px-2 text-sm"
                value={line.unit}
                onChange={(event) => setLine(index, { unit: event.target.value as QuoteLine["unit"] })}
              >
                {UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {units[unit]}
                  </option>
                ))}
              </select>
              <Input
                aria-label={copy.price}
                type="number"
                min="0"
                value={line.unitPrice}
                onChange={(event) => setLine(index, { unitPrice: Number(event.target.value) || 0 })}
              />
              <Button variant="ghost" size="icon" aria-label="×" onClick={() => set("lines", lines.filter((_, at) => at !== index))}>
                <XIcon />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="w-fit gap-1.5"
            onClick={() => set("lines", [...lines, { description: "", quantity: 1, unit: "stk", unitPrice: 0 }])}
          >
            <PlusIcon /> {copy.addLine}
          </Button>
        </div>
        <p className="text-right text-sm">
          {copy.total} {pricesIncludeVat ? copy.vatIncl : copy.vatExcl}:{" "}
          <span className="font-serif tabular text-xl">{formatNok(pricesIncludeVat ? totals.total : totals.subtotal)}</span>
        </p>
        <Field label={copy.notes}>
          <Textarea value={text(draft, "notes")} onChange={(event) => set("notes", event.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={copy.email}>
            <Input value={text(draft, "customerEmail")} onChange={(event) => set("customerEmail", event.target.value || null)} />
          </Field>
          <Field label={copy.to}>
            <Input value={text(draft, "customerPhone")} onChange={(event) => set("customerPhone", event.target.value || null)} />
          </Field>
        </div>
      </div>
    );
  }

  if (action.kind === "booking") {
    const startsAt = text(draft, "startsAt");
    const endsAt = text(draft, "endsAt");
    const minutes = startsAt && endsAt ? Math.max(10, Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000)) : 60;
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={copy.start}>
          <Input
            type="datetime-local"
            value={startsAt ? toLocalInput(startsAt, timeZone) : ""}
            onChange={(event) => {
              const iso = fromLocalInput(event.target.value, timeZone);
              if (iso) setDraft({ ...draft, startsAt: iso, endsAt: new Date(Date.parse(iso) + minutes * 60_000).toISOString() });
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
          <Input value={text(draft, "title")} onChange={(event) => set("title", event.target.value)} />
        </Field>
        <Field label={copy.address} wide>
          <Input value={text(draft, "address")} onChange={(event) => set("address", event.target.value)} />
        </Field>
        <Field label={copy.confirmation} wide>
          <Textarea
            value={text(draft, "confirmationSms")}
            placeholder={copy.noConfirmation}
            onChange={(event) => set("confirmationSms", event.target.value.trim() ? event.target.value : null)}
          />
        </Field>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={copy.to}>
          <Input value={text(draft, "to")} onChange={(event) => set("to", event.target.value || null)} />
        </Field>
        <Field label={copy.email}>
          <Input value={text(draft, "email")} onChange={(event) => set("email", event.target.value || null)} />
        </Field>
      </div>
      <Field label={copy.message}>
        <Textarea rows={4} value={text(draft, "body")} onChange={(event) => set("body", event.target.value)} />
      </Field>
      {draft.includeUploadLink ? (
        <p className="text-muted-foreground text-xs">{copy.uploadLinkNote.replace("{link}", "{lenke}")}</p>
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
