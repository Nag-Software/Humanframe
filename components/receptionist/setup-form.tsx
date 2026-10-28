"use client";

import { useEffect, useState } from "react";
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";

import { useLocale, useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatMessage } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/utils";
import type { ProfileInput } from "@/server/receptionist/profile";

import { formatInZone, formatPhone } from "./format";

type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
const DAYS: Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
type Missing = "name" | "summary" | "hours" | "ownerPhone";

/**
 * Oppsett, top to bottom in the order an owner does it: let the website fill
 * the profile, correct it, decide how booking works, say where alerts go, and
 * finally get the number and forward the phone to it.
 */
export function SetupForm({
  initialProfile,
  initialReadiness,
  learnedFrom,
  number: initialNumber,
  calendar,
  feedUrl: initialFeedUrl,
  origin,
  canEdit,
  widgetKey,
}: {
  initialProfile: ProfileInput;
  initialReadiness: { ready: boolean; missing: Missing[] };
  learnedFrom: string[];
  number: { e164: string; forwardedFrom: string | null } | null;
  calendar: { email: string | null } | null;
  feedUrl: string | null;
  origin: string;
  canEdit: boolean;
  widgetKey: string;
}) {
  const t = useTranslations();
  const copy = t.receptionist.setup;
  const [profile, setProfile] = useState<ProfileInput>(initialProfile);
  const [readiness, setReadiness] = useState(initialReadiness);
  const [sources, setSources] = useState<string[]>(learnedFrom);
  const [saveState, setSaveState] = useState<{ kind: "idle" | "saving" | "saved" | "error"; message?: string }>({
    kind: "idle",
  });
  const [feedUrl, setFeedUrl] = useState(initialFeedUrl);

  const set = <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) =>
    setProfile((current) => ({ ...current, [key]: value }));

  async function save() {
    setSaveState({ kind: "saving" });
    try {
      const response = await fetch("/api/receptionist/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile, learnedFrom: sources }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        readiness?: { ready: boolean; missing: Missing[] };
        profile?: { calendarFeedToken?: string };
        message?: string;
        field?: string;
      };
      if (!response.ok) {
        setSaveState({
          kind: "error",
          message: [body.field, body.message].filter(Boolean).join(": ") || response.statusText,
        });
        return;
      }
      if (body.readiness) setReadiness(body.readiness);
      if (body.profile?.calendarFeedToken && origin) {
        setFeedUrl(`${origin}/api/calendar/feed/${body.profile.calendarFeedToken}.ics`);
      }
      setSaveState({ kind: "saved" });
      // The first save creates the profile row, and with it the widget key.
      if (!widgetKey) window.location.reload();
    } catch {
      setSaveState({ kind: "error", message: "network" });
    }
  }

  return (
    <fieldset disabled={!canEdit} className="flex flex-col gap-12">
      <LearnSection
        onLearned={(draft, learnedSources) => {
          setProfile(draft);
          setSources(learnedSources);
        }}
        defaultUrl={profile.websiteUrl ?? ""}
      />

      <WidgetSection profile={profile} set={set} widgetKey={widgetKey} origin={origin} />

      <PriceSection profile={profile} set={set} />

      <Section title={copy.profileTitle}>
        <TextField label={copy.name} value={profile.name} onChange={(value) => set("name", value)} />
        <AreaField label={copy.summary} value={profile.summary} onChange={(value) => set("summary", value)} />
        <ServicesField profile={profile} set={set} />
        <AreaField label={copy.prices} value={profile.prices} onChange={(value) => set("prices", value)} />
        <HoursField profile={profile} set={set} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label={copy.address} value={profile.address} onChange={(value) => set("address", value)} />
          <TextField label={copy.serviceArea} value={profile.serviceArea} onChange={(value) => set("serviceArea", value)} />
          <TextField label={copy.contactPhone} value={profile.contactPhone} onChange={(value) => set("contactPhone", value)} />
          <TextField label={copy.contactEmail} value={profile.contactEmail} onChange={(value) => set("contactEmail", value)} />
          <TextField
            label={copy.website}
            value={profile.websiteUrl ?? ""}
            onChange={(value) => set("websiteUrl", value || null)}
          />
          <TextField label={copy.infoUrl} value={profile.infoUrl ?? ""} onChange={(value) => set("infoUrl", value || null)} />
        </div>
        <FaqField profile={profile} set={set} />
        <AreaField
          label={copy.instructions}
          placeholder={copy.instructionsPlaceholder}
          value={profile.instructions}
          onChange={(value) => set("instructions", value)}
        />
        <AreaField
          label={copy.greeting}
          placeholder={copy.greetingPlaceholder}
          value={profile.greeting}
          onChange={(value) => set("greeting", value)}
        />
      </Section>

      <Section title={copy.bookingTitle}>
        <ToggleField
          label={copy.bookingEnabled}
          checked={profile.bookingEnabled}
          onChange={(value) => set("bookingEnabled", value)}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            label={copy.appointmentMinutes}
            value={profile.appointmentMinutes}
            min={10}
            max={600}
            onChange={(value) => set("appointmentMinutes", value)}
          />
          <NumberField
            label={copy.bufferMinutes}
            value={profile.bufferMinutes}
            min={0}
            max={240}
            onChange={(value) => set("bufferMinutes", value)}
          />
          <NumberField
            label={copy.minNoticeHours}
            value={profile.minNoticeHours}
            min={0}
            max={336}
            onChange={(value) => set("minNoticeHours", value)}
          />
        </div>
        <TextField label={copy.timezone} value={profile.timezone} onChange={(value) => set("timezone", value)} />
        <CalendarConnect calendar={calendar} />
        <SlotsPreview />
        {feedUrl ? <FeedField url={feedUrl} onRotated={(token) => setFeedUrl(`${origin}/api/calendar/feed/${token}.ics`)} /> : null}
      </Section>

      <Section title={copy.notifyTitle}>
        <TextField
          label={copy.ownerPhone}
          value={profile.ownerPhone ?? ""}
          onChange={(value) => set("ownerPhone", value || null)}
          inputMode="tel"
        />
        <ToggleField label={copy.notifySms} checked={profile.notifySms} onChange={(value) => set("notifySms", value)} />
        <ToggleField label={copy.notifyEmail} checked={profile.notifyEmail} onChange={(value) => set("notifyEmail", value)} />
        <TextField
          label={copy.smsSender}
          hint={copy.smsSenderHint}
          value={profile.smsSender ?? ""}
          onChange={(value) => set("smsSender", value || null)}
        />
        <TestSmsButton />
      </Section>

      <div className="bg-card/90 shadow-lift sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3 backdrop-blur">
        <Button className="h-10 rounded-xl px-5" onClick={() => void save()} disabled={saveState.kind === "saving"}>
          {saveState.kind === "saving" ? copy.saving : copy.save}
        </Button>
        <p
          role="status"
          className={cn("text-sm", saveState.kind === "error" ? "text-destructive" : "text-muted-foreground")}
        >
          {saveState.kind === "saved"
            ? copy.saved
            : saveState.kind === "error"
              ? formatMessage(copy.saveFailed, { message: saveState.message ?? "" })
              : readiness.ready
                ? copy.readinessReady
                : formatMessage(copy.readinessMissing, {
                    fields: readiness.missing.map((key) => copy.missing[key]).join(", "),
                  })}
        </p>
      </div>

      <details className="group">
        <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
          <span className="transition-transform group-open:rotate-90">›</span> {copy.phoneTitle}
        </summary>
        <p className="text-muted-foreground mt-2 text-sm">{copy.phoneLater}</p>
        <div className="mt-6">
          <NumberSection initial={initialNumber} />
        </div>
      </details>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

function LearnSection({
  onLearned,
  defaultUrl,
}: {
  onLearned: (draft: ProfileInput, sources: string[]) => void;
  defaultUrl: string;
}) {
  const copy = useTranslations().receptionist.setup;
  const [url, setUrl] = useState(defaultUrl);
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done" | "error"; message?: string; noHours?: boolean }>({
    kind: "idle",
  });

  async function learn() {
    setState({ kind: "busy" });
    try {
      const response = await fetch("/api/receptionist/learn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        draft?: ProfileInput;
        sources?: string[];
        hoursFound?: boolean;
        message?: string;
        error?: string;
      };
      if (!response.ok || !body.draft) {
        setState({ kind: "error", message: body.message ?? body.error ?? String(response.status) });
        return;
      }
      onLearned(body.draft, body.sources ?? []);
      setState({
        kind: "done",
        message: formatMessage(copy.learned, { count: body.sources?.length ?? 1 }),
        noHours: body.hoursFound === false,
      });
    } catch {
      setState({ kind: "error", message: "network" });
    }
  }

  return (
    <Section title={copy.learnTitle} description={copy.learnDescription}>
      <div className="flex gap-2">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://"
          inputMode="url"
          className="h-9"
        />
        <Button onClick={() => void learn()} disabled={state.kind === "busy" || url.trim().length < 3}>
          {state.kind === "busy" ? copy.learning : copy.learnButton}
        </Button>
      </div>
      {state.kind === "done" ? (
        <p className="text-muted-foreground text-sm">
          {state.message} {state.noHours ? copy.noHours : null}
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p className="text-destructive text-sm">{formatMessage(copy.learnFailed, { message: state.message ?? "" })}</p>
      ) : null}
    </Section>
  );
}

function ServicesField({
  profile,
  set,
}: {
  profile: ProfileInput;
  set: <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) => void;
}) {
  const copy = useTranslations().receptionist.setup;
  const services = profile.services;
  const update = (index: number, patch: Partial<ProfileInput["services"][number]>) =>
    set(
      "services",
      services.map((service, at) => (at === index ? { ...service, ...patch } : service))
    );

  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground text-xs font-medium">{copy.services}</span>
      {services.map((service, index) => (
        <div key={index} className="grid grid-cols-[1fr_8rem_auto] gap-2">
          <Input
            aria-label={copy.serviceName}
            placeholder={copy.serviceName}
            value={service.name}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <Input
            aria-label={copy.servicePrice}
            placeholder={copy.servicePrice}
            value={service.price}
            onChange={(event) => update(index, { price: event.target.value })}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={copy.remove}
            onClick={() => set("services", services.filter((_, at) => at !== index))}
          >
            <XIcon />
          </Button>
          <Input
            className="col-span-2"
            aria-label={copy.serviceDescription}
            placeholder={copy.serviceDescription}
            value={service.description}
            onChange={(event) => update(index, { description: event.target.value })}
          />
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="w-fit gap-1.5"
        onClick={() => set("services", [...services, { name: "", description: "", price: "" }])}
      >
        <PlusIcon /> {copy.addService}
      </Button>
    </div>
  );
}

function HoursField({
  profile,
  set,
}: {
  profile: ProfileInput;
  set: <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) => void;
}) {
  const copy = useTranslations().receptionist.setup;
  const hours = profile.openingHours;

  const setDay = (day: Day, ranges: [string, string][]) => set("openingHours", { ...hours, [day]: ranges });

  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground text-xs font-medium">{copy.hours}</span>
      <div className="flex flex-col gap-1.5">
        {DAYS.map((day) => {
          const ranges = hours[day] ?? [];
          const open = ranges.length > 0;
          return (
            <div key={day} className="grid grid-cols-[6.5rem_auto_1fr] items-center gap-3">
              <span className="text-sm">{copy.days[day]}</span>
              <Switch
                checked={open}
                onCheckedChange={(checked) => setDay(day, checked ? [["08:00", "16:00"]] : [])}
                aria-label={copy.days[day]}
              />
              {open ? (
                <div className="flex flex-wrap items-center gap-2">
                  {ranges.map(([from, to], index) => (
                    <span key={index} className="flex items-center gap-1">
                      <Input
                        type="time"
                        className="h-8 w-[6.5rem]"
                        value={from}
                        onChange={(event) =>
                          setDay(
                            day,
                            ranges.map((range, at) => (at === index ? [event.target.value, range[1]] : range))
                          )
                        }
                      />
                      <span className="text-muted-foreground">–</span>
                      <Input
                        type="time"
                        className="h-8 w-[6.5rem]"
                        value={to}
                        onChange={(event) =>
                          setDay(
                            day,
                            ranges.map((range, at) => (at === index ? [range[0], event.target.value] : range))
                          )
                        }
                      />
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground text-sm">{copy.closed}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FaqField({
  profile,
  set,
}: {
  profile: ProfileInput;
  set: <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) => void;
}) {
  const copy = useTranslations().receptionist.setup;
  const faq = profile.faq;
  const update = (index: number, patch: Partial<ProfileInput["faq"][number]>) =>
    set(
      "faq",
      faq.map((entry, at) => (at === index ? { ...entry, ...patch } : entry))
    );

  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground text-xs font-medium">{copy.faq}</span>
      {faq.map((entry, index) => (
        <div key={index} className="flex flex-col gap-1.5 rounded-lg border p-2">
          <div className="flex gap-2">
            <Input
              placeholder={copy.question}
              value={entry.q}
              onChange={(event) => update(index, { q: event.target.value })}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={copy.remove}
              onClick={() => set("faq", faq.filter((_, at) => at !== index))}
            >
              <XIcon />
            </Button>
          </div>
          <Textarea placeholder={copy.answer} value={entry.a} onChange={(event) => update(index, { a: event.target.value })} />
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="w-fit gap-1.5"
        onClick={() => set("faq", [...faq, { q: "", a: "" }])}
      >
        <PlusIcon /> {copy.addFaq}
      </Button>
    </div>
  );
}

function CalendarConnect({ calendar }: { calendar: { email: string | null } | null }) {
  const copy = useTranslations().receptionist.setup;
  const [busy, setBusy] = useState(false);

  if (calendar) {
    return (
      <p className="flex items-center gap-1.5 text-sm">
        <CheckIcon className="size-4 text-emerald-600" />
        {copy.calendarConnected} {calendar.email ? <span className="text-muted-foreground">({calendar.email})</span> : null}
      </p>
    );
  }

  async function connect() {
    setBusy(true);
    try {
      const response = await fetch("/api/connectors/auth-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "googlecalendar" }),
      });
      const body = (await response.json().catch(() => ({}))) as { redirectUrl?: string };
      if (body.redirectUrl) {
        window.location.assign(body.redirectUrl);
        return;
      }
      window.location.reload();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="border-border/60 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
      <p className="text-muted-foreground max-w-md text-sm">{copy.calendarConnect}</p>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void connect()}>
        {copy.connectCalendar}
      </Button>
    </div>
  );
}

function SlotsPreview() {
  const copy = useTranslations().receptionist.setup;
  const locale = useLocale();
  const [data, setData] = useState<{
    slots: { start: string }[];
    known: boolean;
    timezone: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/receptionist/slots")
      .then((response) => response.json())
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">{copy.slotsPreview}</span>
      {!data.known ? (
        <p className="text-muted-foreground text-sm">{copy.slotsUnknown}</p>
      ) : data.slots.length === 0 ? (
        <p className="text-muted-foreground text-sm">{copy.noSlots}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {data.slots.map((slot) => (
            <li key={slot.start} className="bg-muted rounded-md px-2 py-1 text-xs">
              {formatInZone(slot.start, data.timezone, locale)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FeedField({ url, onRotated }: { url: string; onRotated: (token: string) => void }) {
  const copy = useTranslations().receptionist.setup;
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">{copy.feedTitle}</span>
      <p className="text-muted-foreground text-sm">{copy.feedDescription}</p>
      <div className="flex gap-2">
        <Input readOnly value={url} className="h-9 font-mono text-xs" onFocus={(event) => event.target.select()} />
        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? copy.copied : copy.copy}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-9"
          onClick={() => {
            void fetch("/api/receptionist/feed-token", { method: "POST" })
              .then((response) => response.json())
              .then((body: { token?: string }) => {
                if (body.token) onRotated(body.token);
              });
          }}
        >
          {copy.rotate}
        </Button>
      </div>
    </div>
  );
}

function TestSmsButton() {
  const copy = useTranslations().receptionist.setup;
  const [state, setState] = useState<"idle" | "busy" | "sent" | "failed">("idle");
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        disabled={state === "busy"}
        onClick={() => {
          setState("busy");
          void fetch("/api/receptionist/test-sms", { method: "POST" })
            .then((response) => setState(response.ok ? "sent" : "failed"))
            .catch(() => setState("failed"));
        }}
      >
        {copy.testSms}
      </Button>
      {state === "sent" ? <span className="text-muted-foreground text-sm">{copy.testSent}</span> : null}
      {state === "failed" ? <span className="text-destructive text-sm">{copy.testFailed}</span> : null}
    </div>
  );
}

function NumberSection({ initial }: { initial: { e164: string; forwardedFrom: string | null } | null }) {
  const copy = useTranslations().receptionist.setup;
  const [number, setNumber] = useState(initial);
  const [forwardedFrom, setForwardedFrom] = useState(initial?.forwardedFrom ?? "");
  const [state, setState] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function getNumber() {
    setState({ kind: "busy" });
    try {
      const response = await fetch("/api/receptionist/number", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ forwardedFrom: forwardedFrom || undefined }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        number?: { e164: string; forwardedFrom: string | null };
        message?: string;
        error?: string;
      };
      if (!response.ok || !body.number) {
        setState({ kind: "error", message: body.message ?? body.error ?? String(response.status) });
        return;
      }
      setNumber(body.number);
      setState({ kind: "idle" });
    } catch {
      setState({ kind: "error", message: "network" });
    }
  }

  const target = number?.e164 ?? "";
  const dial = target.replace(/^\+47/, "");

  return (
    <Section title={copy.numberTitle} description={copy.numberDescription}>
      <TextField label={copy.forwardFrom} value={forwardedFrom} onChange={setForwardedFrom} inputMode="tel" />
      {number ? (
        <div className="flex flex-col gap-4">
          <div>
            <span className="text-muted-foreground text-xs font-medium">{copy.yourNumber}</span>
            <p className="font-display text-2xl font-semibold tracking-tight">{formatPhone(number.e164)}</p>
          </div>
          <div className="border-border/60 flex flex-col gap-2 rounded-xl border p-4 text-sm">
            <p className="font-medium">{copy.forwardTitle}</p>
            <p className="text-muted-foreground">{copy.forwardMobile}</p>
            <ForwardCode label={copy.forwardNoAnswer} code={`**61*${dial}#`} />
            <ForwardCode label={copy.forwardBusy} code={`**67*${dial}#`} />
            <ForwardCode label={copy.forwardUnreachable} code={`**62*${dial}#`} />
            <ForwardCode label={copy.forwardCancel} code="##002#" />
            <p className="text-muted-foreground pt-2">{copy.forwardSwitchboard}</p>
          </div>
        </div>
      ) : (
        <Button className="w-fit" onClick={() => void getNumber()} disabled={state.kind === "busy"}>
          {state.kind === "busy" ? copy.gettingNumber : copy.getNumber}
        </Button>
      )}
      {number && forwardedFrom !== (number.forwardedFrom ?? "") ? (
        <Button variant="outline" size="sm" className="w-fit" onClick={() => void getNumber()}>
          {copy.save}
        </Button>
      ) : null}
      {state.kind === "error" ? (
        <p className="text-destructive text-sm">{formatMessage(copy.numberFailed, { message: state.message ?? "" })}</p>
      ) : null}
    </Section>
  );
}

function ForwardCode({ label, code }: { label: string; code: string }) {
  return (
    <p className="flex flex-wrap items-baseline gap-2">
      <span className="text-muted-foreground w-40">{label}</span>
      <a href={`tel:${encodeURIComponent(code)}`} className="font-mono font-medium">
        {code}
      </a>
    </p>
  );
}

// ---------------------------------------------------------------------------

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="space-y-1">
        <h2 className="font-serif text-[1.75rem] leading-tight tracking-[-0.01em]">{title.replace(/^\d+\.\s*/, "")}</h2>
        {description ? <p className="text-muted-foreground max-w-[560px] text-sm leading-relaxed">{description}</p> : null}
      </div>
      <div className="bg-card shadow-hairline flex flex-col gap-5 rounded-2xl p-6">{children}</div>
    </section>
  );
}

function WidgetSection({
  profile,
  set,
  widgetKey,
  origin,
}: {
  profile: ProfileInput;
  set: <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) => void;
  widgetKey: string;
  origin: string;
}) {
  const copy = useTranslations().receptionist.setup;
  const [copied, setCopied] = useState<"snippet" | "link" | null>(null);
  const snippet = `<script src="${origin}/widget.js" data-key="${widgetKey}"${profile.widgetColor ? ` data-color="${profile.widgetColor}"` : ""} async></script>`;
  const link = `${origin}/w/${widgetKey}`;
  const copyText = (value: string, which: "snippet" | "link") =>
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 1800);
    });

  return (
    <Section title={copy.widgetTitle} description={copy.widgetDescription}>
      {widgetKey ? (
        <>
          <div className="bg-primary text-primary-foreground relative overflow-hidden rounded-xl p-4">
            <pre className="overflow-x-auto pr-20 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-all">{snippet}</pre>
            <Button
              size="sm"
              variant="secondary"
              className="absolute top-3 right-3 rounded-lg"
              onClick={() => copyText(snippet, "snippet")}
            >
              {copied === "snippet" ? copy.copied : copy.copy}
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs font-medium">{copy.widgetLink}</span>
            <div className="flex gap-2">
              <Input readOnly value={link} className="h-9 font-mono text-xs" onFocus={(event) => event.target.select()} />
              <Button variant="outline" size="sm" className="h-9 rounded-lg" onClick={() => copyText(link, "link")}>
                {copied === "link" ? copy.copied : copy.copy}
              </Button>
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="bg-fjord text-fjord-foreground flex h-9 items-center rounded-lg px-3 text-sm font-medium whitespace-nowrap"
              >
                {copy.openWidget}
              </a>
            </div>
            <span className="text-muted-foreground text-xs">{copy.widgetLinkHint}</span>
          </div>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">{copy.widgetSaveFirst}</p>
      )}
      <ToggleField label={copy.widgetEnabled} checked={profile.widgetEnabled} onChange={(value) => set("widgetEnabled", value)} />
      <AreaField
        label={copy.widgetGreeting}
        placeholder={copy.widgetGreetingPlaceholder}
        value={profile.widgetGreeting}
        onChange={(value) => set("widgetGreeting", value)}
      />
      <label className="flex items-center justify-between gap-6">
        <span className="text-sm">{copy.widgetColor}</span>
        <span className="flex items-center gap-2">
          <input
            type="color"
            value={profile.widgetColor ?? "#24493f"}
            onChange={(event) => set("widgetColor", event.target.value)}
            className="size-8 cursor-pointer rounded-lg border bg-transparent"
          />
          <span className="text-muted-foreground font-mono text-xs">{profile.widgetColor ?? "#24493F"}</span>
        </span>
      </label>
    </Section>
  );
}

function PriceSection({
  profile,
  set,
}: {
  profile: ProfileInput;
  set: <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) => void;
}) {
  const copy = useTranslations().receptionist.setup;
  const items = profile.priceItems;
  const update = (index: number, patch: Partial<ProfileInput["priceItems"][number]>) =>
    set(
      "priceItems",
      items.map((item, at) => (at === index ? { ...item, ...patch } : item))
    );
  const units = ["stk", "time", "m2", "lm", "fast"] as const;

  return (
    <Section title={copy.priceTitle} description={copy.priceDescription}>
      <div className="flex flex-col gap-2">
        {items.length > 0 ? (
          <div className="text-muted-foreground grid grid-cols-[1fr_6rem_7rem_auto] gap-2 px-1 text-xs font-medium">
            <span>{copy.priceName}</span>
            <span>{copy.priceUnit}</span>
            <span>{copy.pricePrice}</span>
            <span className="w-8" />
          </div>
        ) : null}
        {items.map((item, index) => (
          <div key={index} className="grid grid-cols-[1fr_6rem_7rem_auto] items-center gap-2">
            <Input value={item.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="Timepris" />
            <select
              className="border-input h-8 rounded-lg border bg-transparent px-2 text-sm"
              value={item.unit}
              onChange={(event) => update(index, { unit: event.target.value as (typeof units)[number] })}
            >
              {units.map((unit) => (
                <option key={unit} value={unit}>
                  {copy.units[unit]}
                </option>
              ))}
            </select>
            <Input
              type="number"
              min="0"
              value={item.price}
              onChange={(event) => update(index, { price: Math.max(0, Number(event.target.value) || 0) })}
              className="tabular"
            />
            <Button variant="ghost" size="icon" aria-label={copy.remove} onClick={() => set("priceItems", items.filter((_, at) => at !== index))}>
              <XIcon />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="w-fit gap-1.5"
          onClick={() => set("priceItems", [...items, { name: "", unit: "stk", price: 0 }])}
        >
          <PlusIcon /> {copy.addPrice}
        </Button>
      </div>
      <ToggleField label={copy.pricesIncludeVat} checked={profile.pricesIncludeVat} onChange={(value) => set("pricesIncludeVat", value)} />
      <NumberField label={copy.quoteValidDays} value={profile.quoteValidDays} min={1} max={365} onChange={(value) => set("quoteValidDays", value)} />
      <AreaField label={copy.quoteTerms} value={profile.quoteTerms} onChange={(value) => set("quoteTerms", value)} />
    </Section>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <Input value={value} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} className="h-9" />
      {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
    </label>
  );
}

function AreaField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <Textarea value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))));
        }}
        className="h-9"
      />
    </label>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-6">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
