"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";

import { useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useFacetime } from "@/components/maya/facetime/use-facetime";
import { cn } from "@/lib/utils";

/**
 * FaceTime prototype surface.
 *
 * The Tavus audio element is in the document so echo cancellation can see
 * the audible path. The video element is muted. OpenAI's media track is
 * tapped, not played. This overlay does not request a camera: echo mode
 * has no perception, and the copy says so.
 *
 * The numbers are the point of the prototype. They are not a product UI.
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
  const labels = t.maya.facetime;

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      className="bg-background/80 fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 backdrop-blur-xl"
    >
      <div className="flex flex-col items-center gap-4">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="bg-muted aspect-video w-[min(92vw,42rem)] rounded-2xl object-cover shadow-sm"
        />
        <div className="space-y-1 text-center">
          <p className="text-lg font-medium tracking-tight">{t.nav.maya}</p>
          <p aria-live="polite" className="text-muted-foreground max-w-md text-sm">
            {errorMessage ?? labels.cannotSee}
          </p>
        </div>
      </div>

      <dl
        className={cn(
          "text-muted-foreground grid w-[min(92vw,42rem)] grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-4"
        )}
      >
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

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="lg"
          className="size-11 rounded-full p-0"
          aria-label={muted ? t.maya.call.unmute : t.maya.call.mute}
          aria-pressed={muted}
          disabled={!live}
          onClick={toggleMute}
        >
          {muted ? (
            <MicOffIcon className="size-4" />
          ) : (
            <MicIcon className="size-4" />
          )}
        </Button>
        <Button
          variant="destructive"
          size="lg"
          className="size-11 rounded-full p-0"
          aria-label={t.maya.call.hangUp}
          onClick={() => {
            hangUp();
            onClose();
          }}
        >
          <PhoneOffIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

function ms(value: number): string {
  return `${Math.round(value)} ms`;
}
