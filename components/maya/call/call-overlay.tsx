"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";

import { useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useCall, type CallError, type CallStatus } from "@/components/maya/call/use-call";
import { cn } from "@/lib/utils";

/**
 * The call surface.
 *
 * Deliberately almost nothing: her face, one line of state, and the two
 * controls a person reaches for while talking. No waveform, no transcript
 * ticker, no countdown presented as a budget — the conversation is the
 * interface, and the chat behind it is left exactly as it was.
 */
export function CallOverlay({
  threadId,
  onClose,
}: {
  threadId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const t = useTranslations();
  const call = useCall({ threadId });
  const { hangUp, start, status, threadId: activeThreadId } = call;

  // Opening the surface is the intent to call; there is no second confirmation.
  useEffect(() => {
    if (status === "idle") {
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A call started from the empty state creates the thread server-side. Adopt
  // the id so hanging up leaves the user in the conversation they just had.
  useEffect(() => {
    if (activeThreadId && activeThreadId !== threadId) {
      router.replace(`/assistants/maya?t=${activeThreadId}`);
    }
  }, [activeThreadId, router, threadId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        hangUp();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hangUp, onClose]);

  const live = status === "connected";
  const labels = t.maya.call;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      className="bg-background/80 fixed inset-0 z-50 flex flex-col items-center justify-center gap-10 backdrop-blur-xl"
    >
      <div className="flex flex-col items-center gap-5">
        <span className="relative">
          <span
            aria-hidden
            className={cn(
              "absolute -inset-3 rounded-full transition-opacity duration-700",
              call.speaking
                ? "animate-pulse bg-emerald-500/15 opacity-100"
                : "opacity-0"
            )}
          />
          <Image
            src="/assistants/maya-avatar.png"
            alt=""
            width={112}
            height={112}
            className="relative size-28 rounded-full object-cover shadow-sm"
            priority
          />
        </span>

        <div className="space-y-1 text-center">
          <p className="text-lg font-medium tracking-tight">{t.nav.maya}</p>
          <p aria-live="polite" className="text-muted-foreground min-h-5 text-sm">
            {call.errorMessage ??
              errorLabel(call.error, labels) ??
              statusLabel(status, call.muted, labels)}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="lg"
          className="size-11 rounded-full p-0"
          aria-label={call.muted ? labels.unmute : labels.mute}
          aria-pressed={call.muted}
          disabled={!live}
          onClick={call.toggleMute}
        >
          {call.muted ? (
            <MicOffIcon className="size-4" />
          ) : (
            <MicIcon className="size-4" />
          )}
        </Button>

        <Button
          variant="destructive"
          size="lg"
          className="size-11 rounded-full p-0"
          aria-label={labels.hangUp}
          onClick={() => {
            hangUp();
            onClose();
          }}
        >
          <PhoneOffIcon className="size-4" />
        </Button>
      </div>

      {status === "error" ? (
        <Button variant="ghost" size="sm" onClick={() => void start()}>
          {labels.retry}
        </Button>
      ) : null}
    </div>
  );
}

type Labels = ReturnType<typeof useTranslations>["maya"]["call"];

function statusLabel(status: CallStatus, muted: boolean, labels: Labels): string {
  switch (status) {
    case "requesting-mic":
      return labels.requestingMic;
    case "connecting":
      return labels.connecting;
    case "connected":
      return muted ? labels.muted : labels.connected;
    case "ending":
      return labels.ending;
    case "error":
      return labels.failed;
    default:
      return labels.ready;
  }
}

function errorLabel(error: CallError | null, labels: Labels): string | null {
  switch (error) {
    case "microphone_denied":
      return labels.micDenied;
    case "microphone_missing":
      return labels.micMissing;
    case "connection":
      return labels.connectionLost;
    case "unknown":
      return labels.startFailed;
    default:
      return null;
  }
}
