"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  MessageCircleIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
} from "lucide-react";

import { useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useAudioEnergy } from "@/components/maya/call/use-audio-energy";
import {
  useCall,
  type CallError,
  type CallStatus,
} from "@/components/maya/call/use-call";
import { useElapsed } from "@/components/maya/call/use-elapsed";
import {
  ParticleField,
  type ParticleMode,
} from "@/components/maya/presence/particle-field";
import { formatElapsed } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

const FIELD_SIZE = 440;

/**
 * The call surface.
 *
 * A call is a place, not a dialog: the chat is gone, the room is dark, and
 * she is in the middle of it — not a photograph, but the field of particles
 * that is her presence everywhere in Humanframe. It breathes while she
 * listens and opens when she speaks. One line of state under her name, and
 * the three controls a person reaches for: mute, keep the call and go back to
 * the chat, end.
 *
 * Minimised, the same component renders the slim bar under the presence bar
 * instead. The hook stays mounted either way, so the call never notices.
 */
export function CallOverlay({
  threadId,
  minimized,
  onMinimize,
  onRestore,
  onClose,
}: {
  threadId: string | null;
  minimized: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const t = useTranslations();
  const { energyRef, attach, detach } = useAudioEnergy();
  const call = useCall({
    threadId,
    onRemoteAudioTrack: attach,
    onTeardown: detach,
  });
  const { hangUp, start, status, threadId: activeThreadId } = call;
  const elapsed = useElapsed(status);
  const labels = t.maya.call;

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
    if (minimized) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onMinimize();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [minimized, onMinimize]);

  const end = () => {
    hangUp();
    onClose();
  };

  const live = status === "connected";
  const mode: ParticleMode =
    status === "connected" ? "live" : status === "error" ? "idle" : "ringing";
  const stateText =
    call.errorMessage ??
    errorLabel(call.error, labels) ??
    statusLabel(status, call.muted, elapsed, labels);

  if (minimized) {
    return (
      <div className="bg-call text-call-foreground flex h-10 shrink-0 items-center justify-center gap-3 text-[13px] font-medium">
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full bg-emerald-500",
            live && "animate-pulse"
          )}
        />
        <span>{labels.onCall}</span>
        <span className="font-normal opacity-80 tabular-nums">
          {live ? formatElapsed(elapsed) : stateText}
        </span>
        <Button
          size="xs"
          variant="outline"
          className="border-call-foreground/25 text-call-foreground rounded-full bg-transparent hover:bg-white/40"
          onClick={onRestore}
        >
          {labels.backToCall}
        </Button>
        <Button
          size="xs"
          className="rounded-full bg-[#D64545] text-white hover:bg-[#c23d3d]"
          onClick={end}
        >
          {labels.end}
        </Button>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      className="bg-stage text-stage-foreground fixed inset-0 z-50 flex flex-col"
    >
      <div className="text-stage-foreground/55 flex h-16 shrink-0 items-center px-6 text-[13px]">
        {labels.title}
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6">
        <div
          className="relative"
          style={{ width: FIELD_SIZE, height: FIELD_SIZE }}
        >
          <ParticleField
            size={FIELD_SIZE}
            mode={mode}
            energyRef={energyRef}
            speaking={call.speaking}
            className={cn(
              "text-stage-foreground absolute inset-0 transition-opacity duration-700",
              status === "error" && "opacity-50"
            )}
          />
        </div>

        <div className="space-y-1.5 text-center">
          <p className="font-display text-2xl font-semibold tracking-tight">
            {t.nav.maya}
          </p>
          <p
            aria-live="polite"
            className="text-stage-foreground/60 min-h-5 text-[15px] tabular-nums"
          >
            {stateText}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-center gap-4 pb-14">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            className="text-stage-foreground size-14 rounded-full bg-white/10 hover:bg-white/15 hover:text-stage-foreground disabled:opacity-40"
            aria-label={call.muted ? labels.unmute : labels.mute}
            aria-pressed={call.muted}
            disabled={!live}
            onClick={call.toggleMute}
          >
            {call.muted ? (
              <MicOffIcon className="size-5" />
            ) : (
              <MicIcon className="size-5" />
            )}
          </Button>

          <Button
            variant="ghost"
            className="text-stage-foreground h-12 rounded-full bg-white/10 pr-5 pl-4 text-sm font-medium hover:bg-white/15 hover:text-stage-foreground"
            onClick={onMinimize}
          >
            <MessageCircleIcon className="size-4.5" />
            {labels.continueInChat}
          </Button>

          <Button
            className="size-14 rounded-full bg-[#D64545] text-white hover:bg-[#c23d3d]"
            aria-label={labels.hangUp}
            onClick={end}
          >
            <PhoneOffIcon className="size-5" />
          </Button>
        </div>

        {status === "error" ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-stage-foreground/70 hover:text-stage-foreground hover:bg-white/10"
            onClick={() => void start()}
          >
            {labels.retry}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type Labels = ReturnType<typeof useTranslations>["maya"]["call"];

function statusLabel(
  status: CallStatus,
  muted: boolean,
  elapsed: number,
  labels: Labels
): string {
  switch (status) {
    case "requesting-mic":
    case "connecting":
      return labels.calling;
    case "connected":
      return muted ? labels.muted : formatElapsed(elapsed);
    case "ending":
      return labels.ending;
    case "error":
      return labels.failed;
    default:
      return labels.calling;
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
