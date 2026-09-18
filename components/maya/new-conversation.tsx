"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SendHorizontalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/components/i18n-provider";
import { ParticleField } from "@/components/maya/presence/particle-field";

/**
 * The empty state of a new conversation.
 *
 * The first message goes to the server, which creates the eve session and
 * claims the Supabase thread that owns it. Only then does the URL get a thread
 * id and the eve runtime mount — that order is what keeps thread identity in
 * Humanframe rather than in eve.
 *
 * When the server says there is something to open the day with, Maya speaks
 * first: the same route is asked without a message, and the user is taken to
 * the conversation she has just started. A 204 means she has nothing to say,
 * and the composer simply waits.
 */
export function NewConversation({ openable = false }: { openable?: boolean }) {
  const router = useRouter();
  const t = useTranslations();
  const starters = [
    t.maya.starters.news,
    t.maya.starters.email,
    t.maya.starters.agenda,
  ];
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [opening, setOpening] = useState(openable);
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(false);

  async function start(message: string) {
    const trimmed = message.trim();
    if (trimmed.length === 0 || pending) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/assistants/maya/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });

      if (response.status === 402) {
        // No plan yet: the conversation waits for Billing.
        router.replace("/assistants/maya?settings=billing");
        return;
      }
      if (!response.ok) {
        throw new Error(`session start failed: ${response.status}`);
      }

      const { threadId } = (await response.json()) as { threadId: string };
      router.replace(`/assistants/maya?t=${threadId}`);
    } catch {
      setPending(false);
      setError(t.maya.startFailed);
    }
  }

  useEffect(() => {
    if (!openable || opened.current) {
      return;
    }
    opened.current = true;
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/assistants/maya/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ open: true }),
        });
        if (cancelled) {
          return;
        }
        if (response.status === 204 || !response.ok) {
          setOpening(false);
          return;
        }
        const { threadId } = (await response.json()) as { threadId: string };
        router.replace(`/assistants/maya?t=${threadId}`);
      } catch {
        if (!cancelled) {
          setOpening(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [openable, router]);

  function onSubmit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    void start(value);
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-4">
      <ParticleField
        size={220}
        mode={opening ? "ringing" : "idle"}
        className="text-foreground -my-8"
      />

      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-medium tracking-tight">{t.maya.greeting}</h1>
        <p className="text-muted-foreground text-sm">{t.maya.tagline}</p>
      </div>

      <form onSubmit={onSubmit} className="w-full max-w-xl">
        <div className="border-border/60 bg-background flex items-end gap-2 rounded-2xl border p-2 shadow-sm">
          <textarea
            value={value}
            onChange={(changeEvent) => setValue(changeEvent.target.value)}
            onKeyDown={(keyEvent) => {
              if (keyEvent.key === "Enter" && !keyEvent.shiftKey) {
                keyEvent.preventDefault();
                void start(value);
              }
            }}
            rows={1}
            autoFocus
            disabled={pending}
            placeholder={t.maya.composerPlaceholder}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none"
          />
          <Button
            type="submit"
            size="icon"
            className="size-9 rounded-full"
            disabled={pending || value.trim().length === 0}
            aria-label={t.maya.send}
          >
            <SendHorizontalIcon className="size-4" />
          </Button>
        </div>
      </form>

      {!opening ? (
        <div className="flex w-full max-w-xl flex-col gap-2">
          {starters.map((prompt) => (
            <button
              key={prompt}
              type="button"
              disabled={pending}
              onClick={() => void start(prompt)}
              className="border-border/60 hover:bg-muted/60 rounded-xl border px-3.5 py-2.5 text-start text-sm transition-colors disabled:opacity-50"
            >
              {prompt}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="status" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
