"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarIcon, CheckIcon, ImageIcon, Loader2Icon, MailIcon, PhoneIcon } from "lucide-react";

import { formatNok } from "@/components/hf/money";
import { LogoMark } from "@/components/hf/logo";
import { UploadForm } from "@/components/receptionist/upload-form";
import { cn } from "@/lib/utils";

type QuoteView = {
  id: string;
  number: number;
  status: "sent" | "accepted" | "declined" | "expired" | "withdrawn";
  title: string;
  lines: { description: string; quantity: number; unit: string; unitPrice: number }[];
  notes: string;
  terms: string;
  pricesIncludeVat: boolean;
  subtotal: number;
  vat: number;
  total: number;
  validUntil: string;
};

const UNIT: Record<string, string> = { stk: "stk", time: "t", m2: "m²", lm: "lm", fast: "" };

function when(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("nb-NO", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** The customer's page. Norwegian, plain, and one obvious next step at a time. */
export function PortalView({
  token,
  business,
  inquiry,
  quotes,
  booked,
  requested,
  slots,
}: {
  token: string;
  business: { name: string; phone: string; email: string; color: string | null; timeZone: string };
  inquiry: { title: string; summary: string; customerName: string | null; startedAt: string; status: string; photos: number };
  quotes: QuoteView[];
  booked: { start: string; end: string } | null;
  requested: string | null;
  slots: string[];
}) {
  const router = useRouter();
  const accent = business.color ?? "#24493F";
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const [uploadToken, setUploadToken] = useState<string | null>(null);

  const quote = quotes[0] ?? null;
  const accepted = quotes.some((item) => item.status === "accepted");
  const first = inquiry.customerName?.trim().split(/\s+/)[0];

  async function act(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(`/api/portal/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!response.ok) {
        setError(result.error === "not_open" ? "Tilbudet er ikke lenger åpent." : "Det gikk ikke. Prøv igjen.");
        return null;
      }
      router.refresh();
      return result;
    } catch {
      setError("Fikk ikke kontakt. Prøv igjen.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const steps = [
    { label: "Mottatt", done: true },
    { label: "Tilbud", done: Boolean(quote) },
    { label: "Godtatt", done: accepted },
    { label: "Avtalt tid", done: Boolean(booked) },
  ];

  return (
    <div className="min-h-dvh pb-16">
      <header className="mx-auto flex max-w-[640px] items-center gap-3 px-5 pt-8">
        <span className="flex size-11 items-center justify-center rounded-xl font-serif text-2xl text-white" style={{ background: accent }}>
          {business.name.slice(0, 1)}
        </span>
        <div>
          <p className="font-serif text-2xl leading-tight">{business.name}</p>
          <p className="text-muted-foreground text-sm">Saken din</p>
        </div>
      </header>

      <main className="mx-auto mt-8 flex max-w-[640px] flex-col gap-6 px-5">
        <section>
          <h1 className="font-serif text-[2.4rem] leading-[1.05] tracking-[-0.02em] text-balance">
            {first ? `Hei ${first}.` : "Hei."} {inquiry.title}
          </h1>
          {inquiry.summary ? <p className="text-muted-foreground mt-3 text-[15px] leading-relaxed">{inquiry.summary}</p> : null}
          <ol className="mt-6 grid grid-cols-4 gap-2">
            {steps.map((step) => (
              <li key={step.label} className="flex flex-col gap-2">
                <span className={cn("h-1 rounded-full", step.done ? "" : "bg-border")} style={step.done ? { background: accent } : undefined} />
                <span className={cn("text-xs", step.done ? "font-medium" : "text-muted-foreground")}>{step.label}</span>
              </li>
            ))}
          </ol>
        </section>

        {error ? <p className="bg-ember-soft text-ember rounded-xl px-4 py-3 text-sm">{error}</p> : null}

        {quote ? (
          <section className="bg-card shadow-hairline overflow-hidden rounded-2xl">
            <div className="flex items-baseline justify-between gap-4 p-6 pb-4">
              <div>
                <p className="text-muted-foreground text-xs font-medium tracking-[0.08em] uppercase">Tilbud {quote.number}</p>
                <p className="mt-1 font-serif text-2xl leading-tight">{quote.title}</p>
              </div>
              <p className="font-serif tabular text-3xl">{formatNok(quote.total)}</p>
            </div>
            <div className="border-t">
              {quote.lines.map((line, index) => (
                <div key={index} className="flex justify-between gap-4 border-b px-6 py-3 text-sm last:border-b-0">
                  <span>
                    {line.description}
                    <span className="text-muted-foreground">
                      {" "}
                      {line.unit === "fast" ? "" : `· ${line.quantity} ${UNIT[line.unit] ?? line.unit}`}
                    </span>
                  </span>
                  <span className="tabular">{formatNok(line.quantity * line.unitPrice)}</span>
                </div>
              ))}
            </div>
            <div className="bg-muted/50 space-y-1 px-6 py-4 text-sm">
              <div className="text-muted-foreground flex justify-between">
                <span>Herav mva</span>
                <span className="tabular">{formatNok(quote.vat, { decimals: true })}</span>
              </div>
              <div className="flex justify-between font-medium">
                <span>Totalt inkl. mva</span>
                <span className="tabular">{formatNok(quote.total, { decimals: true })}</span>
              </div>
            </div>
            {quote.notes || quote.terms ? (
              <div className="text-muted-foreground space-y-2 px-6 py-4 text-[13px] leading-relaxed">
                {quote.notes ? <p>{quote.notes}</p> : null}
                {quote.terms ? <p>{quote.terms}</p> : null}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 border-t p-6">
              {quote.status === "sent" ? (
                <>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void act({ action: "accept", quoteId: quote.id }, "accept")}
                    className="flex h-11 items-center gap-2 rounded-xl px-5 text-sm font-semibold text-white disabled:opacity-60"
                    style={{ background: accent }}
                  >
                    {busy === "accept" ? <Loader2Icon className="size-4 animate-spin" /> : <CheckIcon className="size-4" />}
                    Godta tilbudet
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      const reason = window.prompt("Vil du si hvorfor? (valgfritt)") ?? undefined;
                      void act({ action: "decline", quoteId: quote.id, reason }, "decline");
                    }}
                    className="text-muted-foreground hover:text-foreground h-11 rounded-xl px-4 text-sm font-medium"
                  >
                    Nei takk
                  </button>
                  <span className="text-muted-foreground ml-auto text-xs">
                    Gyldig til {quote.validUntil.split("-").reverse().join(".")}
                  </span>
                </>
              ) : (
                <p className="flex items-center gap-2 text-sm font-medium">
                  {quote.status === "accepted" ? <CheckIcon className="size-4" style={{ color: accent }} /> : null}
                  {quote.status === "accepted"
                    ? "Du har godtatt tilbudet."
                    : quote.status === "declined"
                      ? "Du takket nei til tilbudet."
                      : quote.status === "expired"
                        ? "Tilbudet har gått ut. Send en melding om du fortsatt er interessert."
                        : "Tilbudet er trukket."}
                </p>
              )}
            </div>
          </section>
        ) : (
          <section className="bg-card shadow-hairline rounded-2xl p-6">
            <p className="font-serif text-2xl leading-tight">Vi ser på saken din.</p>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
              {business.name} har fått forespørselen og kommer tilbake med tilbud eller forslag til tid. Du får beskjed når det skjer.
            </p>
          </section>
        )}

        {booked ? (
          <section className="bg-card shadow-hairline flex items-center gap-4 rounded-2xl p-6">
            <span className="flex size-11 items-center justify-center rounded-xl text-white" style={{ background: accent }}>
              <CalendarIcon className="size-5" />
            </span>
            <div>
              <p className="text-muted-foreground text-xs font-medium tracking-[0.08em] uppercase">Avtalt</p>
              <p className="font-serif text-xl first-letter:uppercase">{when(booked.start, business.timeZone)}</p>
            </div>
          </section>
        ) : slots.length > 0 && (accepted || !quote) ? (
          <section className="bg-card shadow-hairline rounded-2xl p-6">
            <p className="font-medium">Velg en tid som passer</p>
            <p className="text-muted-foreground mt-1 text-sm">
              {requested
                ? `Du har bedt om ${when(requested, business.timeZone)}. ${business.name} bekrefter.`
                : `${business.name} bekrefter tiden du velger.`}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {slots.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void act({ action: "time", start: slot }, slot)}
                  className={cn(
                    "rounded-xl border px-3 py-2.5 text-left text-sm transition-colors first-letter:uppercase",
                    requested === slot ? "text-white" : "hover:bg-accent"
                  )}
                  style={requested === slot ? { background: accent, borderColor: accent } : undefined}
                >
                  {busy === slot ? <Loader2Icon className="size-4 animate-spin" /> : when(slot, business.timeZone)}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className="bg-card shadow-hairline rounded-2xl p-6">
          <p className="flex items-center gap-2 font-medium">
            <ImageIcon className="text-muted-foreground size-4" /> Bilder
            <span className="text-muted-foreground text-sm font-normal">({inquiry.photos} lagt ved)</span>
          </p>
          <div className="mt-4">
            {uploadToken ? (
              <UploadForm token={uploadToken} remaining={10} />
            ) : (
              <button
                type="button"
                onClick={() => void act({ action: "upload_link" }, "upload").then((result) => result?.token && setUploadToken(result.token))}
                className="hover:bg-accent rounded-xl border px-4 py-2.5 text-sm font-medium"
              >
                {busy === "upload" ? "…" : "Legg til bilder"}
              </button>
            )}
          </div>
        </section>

        <section className="bg-card shadow-hairline rounded-2xl p-6">
          <p className="font-medium">Send en melding</p>
          {sent ? (
            <p className="text-muted-foreground mt-2 text-sm">Takk! {business.name} har fått meldingen.</p>
          ) : (
            <form
              className="mt-3 flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void act({ action: "message", text: message }, "message").then((result) => {
                  if (result) {
                    setSent(true);
                    setMessage("");
                  }
                });
              }}
            >
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={3}
                placeholder="Spørsmål, endringer, adgang til boligen …"
                className="bg-background rounded-xl border px-3 py-2.5 text-[15px] outline-none focus:ring-2"
              />
              <button
                type="submit"
                disabled={!message.trim() || busy !== null}
                className="h-10 w-fit rounded-xl px-4 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: accent }}
              >
                Send
              </button>
            </form>
          )}
          <div className="text-muted-foreground mt-5 flex flex-wrap gap-4 border-t pt-4 text-sm">
            {business.phone ? (
              <a href={`tel:${business.phone}`} className="hover:text-foreground flex items-center gap-1.5">
                <PhoneIcon className="size-4" /> {business.phone}
              </a>
            ) : null}
            {business.email ? (
              <a href={`mailto:${business.email}`} className="hover:text-foreground flex items-center gap-1.5">
                <MailIcon className="size-4" /> {business.email}
              </a>
            ) : null}
          </div>
        </section>

        <p className="text-muted-foreground flex items-center justify-center gap-1.5 pt-4 text-xs">
          <LogoMark className="size-3.5" /> Drevet av Humanframe
        </p>
      </main>
    </div>
  );
}
