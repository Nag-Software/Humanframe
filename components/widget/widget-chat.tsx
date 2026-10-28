"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, CheckIcon, ImageIcon, Loader2Icon, PaperclipIcon, XIcon } from "lucide-react";

import { LogoMark } from "@/components/hf/logo";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Message = { role: "user" | "assistant"; content: string };
type Collected = {
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  job: string | null;
  when: string | null;
};

type Stored = {
  sessionId: string;
  uploadToken: string;
  messages: Message[];
  photos: number;
  collected: Collected | null;
  canSubmit: boolean;
  portalUrl: string | null;
};

function displayPhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "").replace(/^47(?=\d{8}$)/, "");
  return /^\d{8}$/.test(digits) ? `${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5)}` : value;
}

const EMPTY: Collected = { name: null, phone: null, email: null, address: null, job: null, when: null };

/**
 * The conversation a customer has on the business's website. Norwegian,
 * because the customers are; calm and quick, because they are on a phone
 * with a leak under the sink.
 */
export function WidgetChat({
  widgetKey,
  embedded,
  origin,
  business,
  demo,
}: {
  widgetKey: string;
  embedded: boolean;
  origin: string | null;
  business: { name: string; greeting: string; color: string | null; area: string };
  /** A finished-looking conversation for previews; no network is used. */
  demo?: Omit<Stored, "sessionId" | "uploadToken" | "portalUrl">;
}) {
  const storageKey = `humanframe:${widgetKey}`;
  const [state, setState] = useState<Stored | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [contact, setContact] = useState({ name: "", phone: "", email: "" });
  const [showContact, setShowContact] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const accent = business.color ?? "#24493F";

  function persist(next: Stored) {
    setState(next);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Private mode: the conversation lives as long as the page.
    }
  }

  useEffect(() => {
    if (demo) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- preview data
      setState({ ...demo, sessionId: "demo", uploadToken: "", portalUrl: null });
      return;
    }
    let restored: Stored | null = null;
    try {
      const raw = sessionStorage.getItem(storageKey);
      restored = raw ? (JSON.parse(raw) as Stored) : null;
    } catch {
      restored = null;
    }
    if (restored?.sessionId) {
      setState(restored);
      return;
    }
    void fetch(`/api/widget/${widgetKey}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin }),
    })
      .then((response) => response.json())
      .then((body: { sessionId?: string; uploadToken?: string; greeting?: string; error?: string }) => {
        if (!body.sessionId) {
          setError("Chatten er ikke tilgjengelig akkurat nå. Prøv igjen litt senere.");
          return;
        }
        persist({
          sessionId: body.sessionId,
          uploadToken: body.uploadToken ?? "",
          messages: [{ role: "assistant", content: body.greeting ?? business.greeting }],
          photos: 0,
          collected: null,
          canSubmit: false,
          portalUrl: null,
        });
      })
      .catch(() => setError("Fikk ikke kontakt. Sjekk nettet og prøv igjen."));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [state?.messages.length, busy, state?.canSubmit]);

  async function send(text: string) {
    if (!state || !text.trim() || busy) return;
    const messages: Message[] = [...state.messages, { role: "user", content: text.trim() }];
    persist({ ...state, messages });
    setInput("");
    setSuggestions([]);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/widget/${widgetKey}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, text: text.trim() }),
      });
      const body = (await response.json()) as {
        reply?: string;
        canSubmit?: boolean;
        suggestions?: string[];
        collected?: Collected;
        error?: string;
      };
      if (!response.ok || !body.reply) {
        setError(body.error === "limit" ? "Samtalen er blitt lang. Send forespørselen, så tar vi det derfra." : "Noe gikk galt. Prøv igjen.");
        if (body.error === "limit") setShowContact(true);
        return;
      }
      persist({
        ...state,
        messages: [...messages, { role: "assistant", content: body.reply }],
        collected: body.collected ?? state.collected,
        canSubmit: Boolean(body.canSubmit),
      });
      setSuggestions(body.suggestions ?? []);
    } catch {
      setError("Fikk ikke kontakt. Prøv igjen.");
    } finally {
      setBusy(false);
    }
  }

  async function upload(files: File[]) {
    if (!state || files.length === 0) return;
    setUploading(true);
    setError(null);
    const endpoint = `/api/public/uploads/${encodeURIComponent(state.uploadToken)}`;
    try {
      const prepared = (await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          step: "prepare",
          files: files.slice(0, 6).map((file) => ({ name: file.name, type: file.type, size: file.size })),
        }),
      }).then((response) => response.json())) as { uploads?: { name: string; path: string; token: string }[] };

      const storage = createSupabaseBrowserClient().storage.from("inquiry-files");
      const done: { path: string; name: string }[] = [];
      for (const item of prepared.uploads ?? []) {
        const file = files.find((candidate) => candidate.name === item.name);
        if (!file) continue;
        const { error: uploadError } = await storage.uploadToSignedUrl(item.path, item.token, file, { contentType: file.type });
        if (!uploadError) done.push({ path: item.path, name: item.name });
      }
      const confirmed = done.length
        ? ((await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ step: "confirm", files: done }),
          }).then((response) => response.json())) as { stored?: number })
        : { stored: 0 };
      const stored = confirmed.stored ?? 0;
      if (stored === 0) {
        setError("Bildene kunne ikke lastes opp. Bruk JPG, PNG eller HEIC under 15 MB.");
        return;
      }
      const next = { ...state, photos: state.photos + stored };
      persist(next);
      await send(stored === 1 ? "Jeg har lagt ved et bilde." : `Jeg har lagt ved ${stored} bilder.`);
    } catch {
      setError("Bildene kunne ikke lastes opp. Prøv igjen.");
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/widget/${widgetKey}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          name: contact.name || undefined,
          phone: contact.phone || undefined,
          email: contact.email || undefined,
        }),
      });
      const body = (await response.json()) as { portalUrl?: string; error?: string };
      if (!response.ok || !body.portalUrl) {
        if (body.error === "incomplete") {
          setShowContact(true);
          setError("Vi trenger navn og telefon eller e-post, og hva det gjelder.");
        } else {
          setError("Kunne ikke sende. Prøv igjen.");
        }
        return;
      }
      persist({ ...state, portalUrl: body.portalUrl });
    } catch {
      setError("Fikk ikke kontakt. Prøv igjen.");
    } finally {
      setBusy(false);
    }
  }

  const collected = state?.collected ?? EMPTY;
  const done = Boolean(state?.portalUrl);

  return (
    <div className="bg-background flex h-dvh flex-col" style={{ ["--widget-accent" as string]: accent }}>
      <header className="flex items-center gap-3 border-b px-5 py-4">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-xl font-serif text-xl text-white"
          style={{ background: accent }}
        >
          {business.name.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-serif text-[1.35rem] leading-tight">{business.name}</p>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Svar fra eieren, ofte samme dag
          </p>
        </div>
        {embedded ? (
          <button
            type="button"
            aria-label="Lukk"
            className="text-muted-foreground hover:bg-accent flex size-9 items-center justify-center rounded-full"
            onClick={() => window.parent.postMessage("humanframe:close", "*")}
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
      </header>

      {done ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <span className="flex size-14 items-center justify-center rounded-full text-white" style={{ background: accent }}>
            <CheckIcon className="size-6" />
          </span>
          <p className="font-serif text-3xl leading-tight">Takk! Forespørselen er sendt.</p>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {business.name} ser på den og svarer deg med tilbud eller forslag til tid. Du kan følge saken og legge til flere bilder
            på siden din.
          </p>
          <a
            href={state!.portalUrl!}
            target="_blank"
            rel="noreferrer"
            className="mt-2 rounded-xl px-5 py-3 text-sm font-semibold text-white"
            style={{ background: accent }}
          >
            Følg saken din
          </a>
        </div>
      ) : (
        <>
          <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-5">
            <div className="flex flex-col gap-3">
              {(state?.messages ?? []).map((message, index) => (
                <div key={index} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-line",
                      message.role === "user" ? "rounded-br-md text-white" : "bg-card shadow-hairline rounded-bl-md"
                    )}
                    style={message.role === "user" ? { background: accent } : undefined}
                  >
                    {message.content}
                  </div>
                </div>
              ))}
              {busy ? (
                <div className="flex justify-start">
                  <div className="bg-card shadow-hairline flex gap-1 rounded-2xl rounded-bl-md px-4 py-3.5">
                    {[0, 1, 2].map((dot) => (
                      <span
                        key={dot}
                        className="bg-muted-foreground/50 size-1.5 animate-bounce rounded-full"
                        style={{ animationDelay: `${dot * 120}ms` }}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
              {state && state.photos > 0 ? (
                <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-xs">
                  <ImageIcon className="size-3.5" /> {state.photos} {state.photos === 1 ? "bilde" : "bilder"} lagt ved
                </p>
              ) : null}
            </div>
          </div>

          {state?.canSubmit || showContact ? (
            <div className="bg-card shadow-lift mx-4 mb-3 rounded-2xl p-4">
              {state?.canSubmit && !showContact ? (
                <>
                  <p className="text-sm font-semibold">Klar til å sende</p>
                  <p className="text-muted-foreground mt-1 text-[13px] leading-relaxed">
                    {[collected.job, collected.name, displayPhone(collected.phone) ?? collected.email, collected.when].filter(Boolean).join(" · ")}
                  </p>
                </>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-semibold">Hvordan når vi deg?</p>
                  <input
                    className="bg-background h-10 rounded-lg border px-3 text-sm"
                    placeholder="Navn"
                    autoComplete="name"
                    value={contact.name || collected.name || ""}
                    onChange={(event) => setContact({ ...contact, name: event.target.value })}
                  />
                  <input
                    className="bg-background h-10 rounded-lg border px-3 text-sm"
                    placeholder="Telefon"
                    inputMode="tel"
                    autoComplete="tel"
                    value={contact.phone || collected.phone || ""}
                    onChange={(event) => setContact({ ...contact, phone: event.target.value })}
                  />
                  <input
                    className="bg-background h-10 rounded-lg border px-3 text-sm"
                    placeholder="E-post"
                    inputMode="email"
                    autoComplete="email"
                    value={contact.email || collected.email || ""}
                    onChange={(event) => setContact({ ...contact, email: event.target.value })}
                  />
                </div>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit()}
                className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white disabled:opacity-60"
                style={{ background: accent }}
              >
                {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
                Send forespørsel til {business.name}
              </button>
            </div>
          ) : null}

          {suggestions.length > 0 && !busy ? (
            <div className="flex flex-wrap gap-2 px-4 pb-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void send(suggestion)}
                  className="bg-card shadow-hairline hover:bg-accent rounded-full px-3 py-1.5 text-[13px]"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}

          {error ? <p className="text-ember px-5 pb-2 text-[13px]">{error}</p> : null}

          <form
            className="px-4 pb-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <div className="bg-card shadow-hairline flex items-end gap-1 rounded-2xl p-1.5 focus-within:ring-2 focus-within:ring-[color:var(--widget-accent)]/30">
              <button
                type="button"
                aria-label="Legg ved bilder"
                disabled={!state || uploading}
                onClick={() => fileInput.current?.click()}
                className="text-muted-foreground hover:bg-accent flex size-10 shrink-0 items-center justify-center rounded-xl"
              >
                {uploading ? <Loader2Icon className="size-4 animate-spin" /> : <PaperclipIcon className="size-4" />}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*,application/pdf"
                multiple
                className="sr-only"
                onChange={(event) => {
                  void upload(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <textarea
                rows={1}
                value={input}
                placeholder="Skriv hva det gjelder …"
                aria-label="Melding"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send(input);
                  }
                }}
                className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-1 py-2.5 text-[15px] outline-none"
              />
              <button
                type="submit"
                aria-label="Send"
                disabled={!state || busy || !input.trim()}
                className="flex size-10 shrink-0 items-center justify-center rounded-xl text-white transition-opacity disabled:opacity-40"
                style={{ background: accent }}
              >
                <ArrowUpIcon className="size-4" />
              </button>
            </div>
          </form>
        </>
      )}

      <footer className="text-muted-foreground flex items-center justify-center gap-1.5 pb-3 text-[11px]">
        <LogoMark className="size-3.5" /> Drevet av Humanframe · Du snakker med en AI-assistent
      </footer>
    </div>
  );
}
