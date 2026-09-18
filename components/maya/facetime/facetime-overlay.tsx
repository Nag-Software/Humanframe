"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";

import { useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useElapsed } from "@/components/maya/call/use-elapsed";
import { useFacetime } from "@/components/maya/facetime/use-facetime";
import { ParticleField } from "@/components/maya/presence/particle-field";
import { formatElapsed } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

/** Controls fade after this long without the pointer moving. */
const CONTROLS_IDLE_MS = 3000;

/**
 * The FaceTime surface.
 *
 * Full-bleed video, her name and the time together in a corner, and controls
 * that float at the bottom and fade when your hands are still — the FaceTime
 * rule. The Tavus audio element stays in the document so echo cancellation
 * can see the audible path; the video element is muted; OpenAI's track is
 * tapped, not played. No camera is requested: she cannot see you yet, and
 * she says so herself early in the call rather than a banner saying it for
 * her.
 *
 * The render-path measurements that built this are still here, behind
 * `?debug=1`. They are not a product surface.
 */
export function FacetimeOverlay({
  threadId,
  onClose,
}: {
  threadId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const t = useTranslations();
  const debug = useSearchParams().get("debug") === "1";
  const {
    hangUp,
    start,
    status,
    threadId: activeThreadId,
    metrics,
    errorMessage,
    muted,
    toggleMute,
    videoRef,
  } = useFacetime({ threadId });
  const elapsed = useElapsed(status);
  const labels = t.maya.facetime;
  const [controlsVisible, setControlsVisible] = useState(true);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (status === "idle") {
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeThreadId && activeThreadId !== threadId) {
      router.replace(`/assistants/maya?t=${activeThreadId}`);
    }
  }, [activeThreadId, router, threadId]);

  useEffect(() => {
    function wake() {
      setControlsVisible(true);
      if (idle.current) {
        clearTimeout(idle.current);
      }
      idle.current = setTimeout(
        () => setControlsVisible(false),
        CONTROLS_IDLE_MS
      );
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        hangUp();
        onClose();
        return;
      }
      wake();
    }
    wake();
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", onKey);
    return () => {
      if (idle.current) {
        clearTimeout(idle.current);
      }
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", onKey);
    };
  }, [hangUp, onClose]);

  const live = status === "connected";
  const showControls = controlsVisible || !live;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      className="bg-stage text-stage-foreground fixed inset-0 z-50 overflow-hidden"
    >
      {!live ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <ParticleField
            size={440}
            mode={status === "error" ? "idle" : "ringing"}
            className="text-stage-foreground"
          />
        </div>
      ) : null}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={cn(
          "absolute inset-0 size-full object-cover transition-opacity duration-700",
          live ? "opacity-100" : "opacity-0"
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/55 to-transparent"
      />

      <div className="absolute top-6 left-7 flex items-center gap-2.5 text-sm drop-shadow-[0_1px_8px_rgba(0,0,0,0.6)]">
        <span className="font-display font-semibold">{t.nav.maya}</span>
        <span aria-live="polite" className="text-stage-foreground/70 tabular-nums">
          {errorMessage ?? (live ? formatElapsed(elapsed) : t.maya.call.calling)}
        </span>
      </div>

      {debug ? (
        <dl className="text-stage-foreground/70 absolute top-16 left-7 grid w-[min(92vw,42rem)] grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-4">
          <Metric label="generated" value={ms(metrics.generatedMs)} />
          <Metric label="handed" value={ms(metrics.handedMs)} />
          <Metric label="played" value={ms(metrics.playedMs)} />
          <Metric label="queue" value={ms(metrics.queueMs)} />
          <Metric label="payload" value={`${metrics.lastPayloadBytes} B`} />
          <Metric label="max payload" value={`${metrics.maxPayloadBytes} B`} />
          <Metric label="over 4 KB" value={String(metrics.overLimitCount)} />
          <Metric
            label="extra delay"
            value={metrics.extraDelayMs === null ? "—" : ms(metrics.extraDelayMs)}
          />
          <Metric
            label="interrupt→silent"
            value={metrics.lastSilenceMs === null ? "—" : ms(metrics.lastSilenceMs)}
          />
          <Metric label="chunks" value={String(metrics.handedCount)} />
          <Metric label="max queue" value={ms(metrics.maxQueueMs)} />
          <Metric label="Daily" value={metrics.dailyState} />
          <Metric
            label="Tavus A/V"
            value={`${metrics.renderAudio ? "A" : "—"}/${metrics.renderVideo ? "V" : "—"}`}
          />
          <Metric label="barge-in" value={metrics.bargeIn ? "yes" : "no"} />
        </dl>
      ) : null}

      <div
        className={cn(
          "absolute inset-x-0 bottom-9 flex justify-center transition-opacity duration-500",
          showControls ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <div className="flex items-center gap-2.5 rounded-full bg-black/45 p-2.5 backdrop-blur-xl">
          <Button
            variant="ghost"
            className="text-stage-foreground size-14 rounded-full bg-white/12 hover:bg-white/18 hover:text-stage-foreground disabled:opacity-40"
            aria-label={muted ? t.maya.call.unmute : t.maya.call.mute}
            aria-pressed={muted}
            disabled={!live}
            onClick={toggleMute}
          >
            {muted ? (
              <MicOffIcon className="size-5" />
            ) : (
              <MicIcon className="size-5" />
            )}
          </Button>
          <Button
            className="size-14 rounded-full bg-[#D64545] text-white hover:bg-[#c23d3d]"
            aria-label={t.maya.call.hangUp}
            onClick={() => {
              hangUp();
              onClose();
            }}
          >
            <PhoneOffIcon className="size-5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-stage-foreground">{value}</dd>
    </div>
  );
}

function ms(value: number): string {
  return `${Math.round(value)} ms`;
}
