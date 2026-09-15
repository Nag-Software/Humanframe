"use client";

import { useCallback, useRef, useState } from "react";
import Daily, { type DailyCall } from "@daily-co/daily-js";

import {
  useCall,
  type CallStartResponse,
  type UseCall,
} from "@/components/maya/call/use-call";
import {
  ECHO_CHUNK_MS,
  ECHO_SAMPLE_RATE,
  echoAudioMessage,
  fitsDailyAppMessage,
  interruptMessage,
  pcm16BytesFor,
} from "@/lib/call/echo-packet";
import { PlaybackLedger } from "@/lib/call/playback-ledger";
import { floatToPcm16, resampleFloat32, rms } from "@/lib/call/pcm";

/**
 * FaceTime prototype transport.
 *
 * OpenAI Live stays the voice agent. This hook joins a Tavus echo room,
 * taps the OpenAI remote audio track, and hands 20 ms PCM chunks to Daily
 * only when the serialised envelope fits 4 KB. sendAppMessage is recorded
 * as handed-to-Daily, never as played.
 *
 * The camera is not requested. Echo mode has no perception; the overlay
 * must not claim Maya can see the user.
 */

const CHUNK_BYTES = pcm16BytesFor(ECHO_CHUNK_MS);
const ENERGY_INTERVAL_MS = 20;
const GENERATION_IDLE_MS = 400;

export type FacetimeMetrics = ReturnType<PlaybackLedger["snapshot"]> & {
  dailyState: string;
  renderJoined: boolean;
  renderAudio: boolean;
  renderVideo: boolean;
};

export type UseFacetime = UseCall & {
  metrics: FacetimeMetrics;
  videoRef: (element: HTMLVideoElement | null) => void;
};

export function useFacetime(options: { threadId: string | null }): UseFacetime {
  const daily = useRef<DailyCall | null>(null);
  const conversationId = useRef<string | null>(null);
  const ledger = useRef(new PlaybackLedger());
  const openaiContext = useRef<AudioContext | null>(null);
  const openaiWorklet = useRef<AudioWorkletNode | null>(null);
  const openaiSource = useRef<MediaStreamAudioSourceNode | null>(null);
  const playContext = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const renderStream = useRef<MediaStream>(new MediaStream());
  const renderAudio = useRef(false);
  const tavusAudio = useRef<HTMLAudioElement | null>(null);
  const energyTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [metrics, setMetrics] = useState<FacetimeMetrics>(emptyMetrics());

  const publish = useCallback(() => {
    const stream = renderStream.current;
    setMetrics({
      ...ledger.current.snapshot(),
      dailyState: daily.current?.meetingState() ?? "idle",
      renderJoined: conversationId.current !== null,
      renderAudio: renderAudio.current,
      renderVideo: stream.getVideoTracks().length > 0,
    });
  }, []);

  const sendEcho = useCallback(
    (pcm: Uint8Array, done: boolean) => {
      const id = conversationId.current;
      const call = daily.current;
      const inferenceId = ledger.current.inferenceId;
      if (!id || !call || !inferenceId) return false;

      const packet = echoAudioMessage({
        conversationId: id,
        pcm,
        inferenceId,
        done,
      });
      if (!fitsDailyAppMessage(packet.bytes)) {
        ledger.current.recordOverLimit();
        publish();
        return false;
      }
      try {
        call.sendAppMessage(packet.message, "*");
      } catch {
        ledger.current.recordOverLimit();
        publish();
        return false;
      }
      ledger.current.recordHanded(pcm, packet.bytes);
      publish();
      return true;
    },
    [publish]
  );

  const flushDone = useCallback(() => {
    const leftover = ledger.current.flushPending();
    if (leftover.length > 0) {
      sendEcho(leftover, false);
    }
    const silence = new Uint8Array(CHUNK_BYTES);
    sendEcho(silence, true);
  }, [sendEcho]);

  const interruptRender = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    const id = conversationId.current;
    const call = daily.current;
    if (id && call) {
      const packet = interruptMessage(id);
      try {
        call.sendAppMessage(packet.message, "*");
      } catch {
        // The face may keep talking. The ledger still drops our queue.
      }
    }
    ledger.current.interrupt();
    publish();
  }, [publish]);

  const ingestOpenai = useCallback(
    (floats: Float32Array, sampleRate: number) => {
      const energy = rms(floats);
      if (!ledger.current.acceptGenerated(energy)) {
        return;
      }

      if (!ledger.current.inferenceId) {
        ledger.current.beginUtterance(crypto.randomUUID());
      }

      const pcm = floatToPcm16(
        resampleFloat32(floats, sampleRate, ECHO_SAMPLE_RATE)
      );
      ledger.current.recordGenerated(pcm);

      let chunk = ledger.current.takeChunk(CHUNK_BYTES);
      while (chunk) {
        sendEcho(chunk, false);
        chunk = ledger.current.takeChunk(CHUNK_BYTES);
      }

      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => {
        flushDone();
      }, GENERATION_IDLE_MS);
    },
    [flushDone, sendEcho]
  );

  const attachOpenaiTrack = useCallback(
    async (track: MediaStreamTrack) => {
      const context = new AudioContext();
      openaiContext.current = context;
      await context.audioWorklet.addModule("/worklets/pcm-tap.js");
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const worklet = new AudioWorkletNode(context, "pcm-tap");
      openaiSource.current = source;
      openaiWorklet.current = worklet;
      worklet.port.onmessage = (event) => {
        const buffer = event.data as Float32Array;
        ingestOpenai(buffer, context.sampleRate);
      };
      // A zero-gain connection to destination is what keeps the worklet
      // scheduled. Routing samples to speakers would be a second audible path.
      const silent = context.createGain();
      silent.gain.value = 0;
      source.connect(worklet);
      worklet.connect(silent);
      silent.connect(context.destination);
    },
    [ingestOpenai]
  );

  const attachRenderTrack = useCallback(
    (track: MediaStreamTrack) => {
      // Daily's call object plays remote audio itself. Putting that same
      // track on our <video> would be a second audible path. Video is ours;
      // audio stays with Daily; the analyser only measures.
      if (track.kind === "video") {
        const stream = renderStream.current;
        if (stream.getTracks().some((existing) => existing.id === track.id)) {
          publish();
          return;
        }
        stream.addTrack(track);
        if (video.current) {
          video.current.srcObject = stream;
          void video.current.play().catch(() => undefined);
        }
        publish();
        return;
      }

      if (track.kind !== "audio") return;
      renderAudio.current = true;

      // One audible path, in the document, so echo cancellation can see it.
      // The video element is muted. Daily's call object does not render
      // media; we own the elements. A speaker test still has to confirm
      // there is not a second Daily-owned player.
      let element = tavusAudio.current;
      if (!element) {
        element = document.createElement("audio");
        element.autoplay = true;
        element.setAttribute("playsinline", "true");
        document.body.append(element);
        tavusAudio.current = element;
      }
      element.srcObject = new MediaStream([track]);
      void element.play().catch(() => undefined);

      const context = playContext.current ?? new AudioContext();
      playContext.current = context;
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const node = context.createAnalyser();
      node.fftSize = 256;
      source.connect(node);
      analyser.current = node;

      if (energyTimer.current) clearInterval(energyTimer.current);
      const bins = new Uint8Array(node.frequencyBinCount);
      energyTimer.current = setInterval(() => {
        node.getByteTimeDomainData(bins);
        let sum = 0;
        for (let i = 0; i < bins.length; i += 1) {
          const sample = ((bins[i] ?? 128) - 128) / 128;
          sum += sample * sample;
        }
        ledger.current.recordPlayed(Math.sqrt(sum / bins.length));
        publish();
      }, ENERGY_INTERVAL_MS);
      publish();
    },
    [publish]
  );

  const joinRender = useCallback(
    async (body: CallStartResponse) => {
      const render = body.render;
      if (!render) return;
      conversationId.current = render.conversationId;

      const call = Daily.createCallObject();
      daily.current = call;
      call.on("track-started", (event) => {
        if (!event.participant || event.participant.local) return;
        if (event.track) attachRenderTrack(event.track);
      });
      try {
        await call.join({
          url: render.conversationUrl,
          audioSource: false,
          videoSource: false,
          subscribeToTracksAutomatically: true,
        });
        if (video.current) {
          void video.current.play().catch(() => undefined);
        }
      } catch {
        conversationId.current = null;
        daily.current = null;
        call.destroy();
      }
      publish();
    },
    [attachRenderTrack, publish]
  );

  const teardownRender = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (energyTimer.current) {
      clearInterval(energyTimer.current);
      energyTimer.current = null;
    }
    openaiWorklet.current?.port.close();
    openaiWorklet.current?.disconnect();
    openaiWorklet.current = null;
    openaiSource.current?.disconnect();
    openaiSource.current = null;
    void openaiContext.current?.close();
    openaiContext.current = null;
    analyser.current?.disconnect();
    analyser.current = null;
    void playContext.current?.close();
    playContext.current = null;

    renderStream.current.getTracks().forEach((track) => {
      track.stop();
      renderStream.current.removeTrack(track);
    });
    renderStream.current = new MediaStream();
    renderAudio.current = false;
    if (video.current) {
      video.current.srcObject = null;
    }
    if (tavusAudio.current) {
      tavusAudio.current.pause();
      tavusAudio.current.srcObject = null;
      tavusAudio.current.remove();
      tavusAudio.current = null;
    }

    const call = daily.current;
    daily.current = null;
    conversationId.current = null;
    if (call) {
      void call.leave().finally(() => call.destroy());
    }
    ledger.current = new PlaybackLedger();
    publish();
  }, [publish]);

  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    video.current = element;
    if (element) {
      element.srcObject = renderStream.current;
    }
  }, []);

  const call = useCall({
    threadId: options.threadId,
    startUrl: "/api/assistants/maya/facetime/start",
    muteProviderAudio: true,
    onRemoteAudioTrack: (track) => {
      void attachOpenaiTrack(track);
    },
    onStart: (body) => {
      void joinRender(body);
    },
    onProviderEvent: (event) => {
      if (
        event.type === "session.input_transcript.delta" &&
        (ledger.current.playing || ledger.current.queueMs() > 0)
      ) {
        interruptRender();
      }
    },
    shouldMarkTurnInterrupted: () => {
      const verdict = ledger.current.persistence();
      return verdict.interrupted;
    },
    onTeardown: teardownRender,
  });

  return { ...call, metrics, videoRef };
}

function emptyMetrics(): FacetimeMetrics {
  return {
    generatedMs: 0,
    handedMs: 0,
    playedMs: 0,
    queueMs: 0,
    lastPayloadBytes: 0,
    maxPayloadBytes: 0,
    overLimitCount: 0,
    handedCount: 0,
    maxQueueMs: 0,
    extraDelayMs: null,
    lastSilenceMs: null,
    inferenceId: null,
    bargeIn: false,
    dailyState: "idle",
    renderJoined: false,
    renderAudio: false,
    renderVideo: false,
  };
}
