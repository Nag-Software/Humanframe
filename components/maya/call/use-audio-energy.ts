"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

import { rms } from "@/lib/call/pcm";

/**
 * How loud she is right now, for the particle field.
 *
 * Taps the remote track through an analyser and writes a 0..1 level into a
 * ref every frame. A ref, not state: sixty updates a second must not re-render
 * anything. The analyser is a listener only — it never connects to the
 * destination, so the call's single audible path is unchanged.
 */
export function useAudioEnergy(): {
  energyRef: RefObject<number>;
  attach: (track: MediaStreamTrack) => void;
  detach: () => void;
} {
  const energy = useRef(0);
  const context = useRef<AudioContext | null>(null);
  const frame = useRef<number | null>(null);

  const detach = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    void context.current?.close().catch(() => undefined);
    context.current = null;
    energy.current = 0;
  }, []);

  const attach = useCallback(
    (track: MediaStreamTrack) => {
      detach();
      const audio = new AudioContext();
      const source = audio.createMediaStreamSource(new MediaStream([track]));
      const analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      context.current = audio;

      const buffer = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buffer);
        // Speech on this track sits around 0.05–0.2 RMS; scale so a normal
        // sentence reaches the top of the range without clipping at once.
        energy.current = Math.min(1, rms(buffer) * 5);
        frame.current = requestAnimationFrame(tick);
      };
      tick();
    },
    [detach]
  );

  useEffect(() => detach, [detach]);

  return { energyRef: energy, attach, detach };
}
