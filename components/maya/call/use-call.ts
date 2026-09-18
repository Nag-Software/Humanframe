"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { TurnAssembler, type TranscriptDelta } from "@/lib/call/turn-assembler";

/**
 * One voice call, from the browser's side.
 *
 * The browser's whole job is transport: it owns the microphone, the peer
 * connection and the data channel, and it relays two kinds of event to the
 * server — a finished turn, and a request for backend work. It holds no
 * credential, decides nothing about scope, and never touches a database.
 *
 * It does own one piece of bookkeeping the provider no longer does: Live sends
 * transcripts as deltas and never says a turn has ended, so the assembler
 * draws that boundary here, where the timestamps arrive.
 *
 * Everything it opens, it closes. Microphone tracks, the audio element, the
 * data channel and the peer connection are all torn down on hang-up, on
 * navigation and on unmount, because a track left live keeps the recording
 * indicator on and the call billing running.
 */
export type CallStatus =
  | "idle"
  | "requesting-mic"
  | "connecting"
  | "connected"
  | "ending"
  | "error";

export type CallError =
  | "microphone_denied"
  | "microphone_missing"
  | "limit"
  | "connection"
  | "unknown";

export type UseCall = {
  status: CallStatus;
  error: CallError | null;
  errorMessage: string | null;
  muted: boolean;
  /** True while Maya is speaking, for the UI's own feedback. */
  speaking: boolean;
  threadId: string | null;
  start: () => Promise<void>;
  toggleMute: () => void;
  hangUp: () => void;
};

export type CallStartResponse = {
  callSessionId: string;
  threadId: string;
  answerSdp: string;
  maxMinutes: number;
  /** What to tell the user when the server's ceiling ends the call. */
  limitMessage?: string;
  render?: {
    conversationId: string;
    conversationUrl: string;
  };
};

type UseCallOptions = {
  threadId: string | null;
  /** Voice Call posts here. The FaceTime prototype posts to its own start. */
  startUrl?: string;
  /**
   * When true the OpenAI media track is not attached to an audio element.
   * FaceTime taps the track and plays Tavus instead. A muted element would
   * not have been a proof of a single audible path.
   */
  muteProviderAudio?: boolean;
  onRemoteAudioTrack?: (track: MediaStreamTrack) => void;
  onStart?: (body: CallStartResponse) => void;
  onProviderEvent?: (event: LiveEvent) => void;
  onTeardown?: () => void;
  /**
   * FaceTime has no sample-accurate playback cursor. When this returns true
   * an assistant turn is stored as interrupted and skipped for memory.
   */
  shouldMarkTurnInterrupted?: () => boolean;
};

type LiveEvent = {
  type?: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  delegation?: { id?: string; target?: string };
};

/** How long after the last audio fragment Maya counts as still speaking. */
const SPEAKING_IDLE_MS = 800;

export function useCall(options: UseCallOptions): UseCall {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [error, setError] = useState<CallError | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(options.threadId);

  const pc = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const callId = useRef<string | null>(null);
  /** Turns already relayed, so a repeated provider event is not sent twice. */
  const relayed = useRef<Set<string>>(new Set());
  /** Live has no transcript-completed event; this decides where turns end. */
  const assembler = useRef<TurnAssembler>(new TurnAssembler());
  /**
   * Live has no `response.done` either — the guide's instruction is to track
   * playback in the client — so "she is speaking" is audio deltas plus a short
   * idle timeout, reset on every fragment.
   */
  const speakingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The courtesy end. The server decided at start how long it will serve this
   * call (the plan's remaining minutes, or the global ceiling) and refuses to
   * serve it past that — but it cannot cut the audio stream itself. This
   * timer is the browser doing that part, and saying why.
   */
  const limitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Which attempt owns the call right now.
   *
   * `start` is async and can be entered twice before React re-renders — Strict
   * Mode double-invokes the mount effect, and a retry can land on top of a
   * connection that is still opening. React state cannot guard that: both
   * entries close over the same stale `status`. A ref changes synchronously,
   * so the second entry is visible to the first the moment it happens.
   *
   * Every attempt captures its generation and re-checks it after each await.
   * An attempt that no longer owns the call disposes whatever it just built
   * instead of leaving a live peer connection nobody holds a reference to —
   * which is a call that keeps talking and can never be hung up.
   */
  const generation = useRef(0);
  const callbacks = useRef(options);
  useEffect(() => {
    callbacks.current = options;
  });

  /**
   * Sends one finished turn to be persisted.
   *
   * Idempotent twice over: the assembler gives a turn a stable id, and this
   * refuses to send one it has already sent, so a reconnect or a repeated
   * fragment cannot produce two messages.
   */
  const relayTurn = useCallback(
    async (turn: {
      sourceId: string;
      role: "user" | "assistant";
      text: string;
      interrupted?: boolean;
    }) => {
      const id = callId.current;
      if (!id || relayed.current.has(turn.sourceId)) {
        return;
      }
      relayed.current.add(turn.sourceId);

      await fetch("/api/assistants/maya/call/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callSessionId: id, ...turn }),
        keepalive: true,
      }).catch(() => undefined);
    },
    []
  );

  /** Releases every resource. Safe to call repeatedly. */
  const teardown = useCallback(() => {
    // Persistence has to read the FaceTime ledger *before* render teardown
    // resets it. Otherwise a heard last turn is stored as uncertain.
    const pending = assembler.current.flush();
    const interrupted =
      pending?.role === "assistant" &&
      callbacks.current.shouldMarkTurnInterrupted?.() === true;
    callbacks.current.onTeardown?.();
    if (pending) {
      void relayTurn({ ...pending, interrupted });
    }
    assembler.current = new TurnAssembler();

    if (speakingTimer.current) {
      clearTimeout(speakingTimer.current);
      speakingTimer.current = null;
    }
    if (limitTimer.current) {
      clearTimeout(limitTimer.current);
      limitTimer.current = null;
    }

    channel.current?.close();
    channel.current = null;

    pc.current?.getSenders().forEach((sender) => sender.track?.stop());
    pc.current?.close();
    pc.current = null;

    microphone.current?.getTracks().forEach((track) => track.stop());
    microphone.current = null;

    if (audio.current) {
      audio.current.pause();
      audio.current.srcObject = null;
      audio.current.remove();
      audio.current = null;
    }

    relayed.current.clear();
    setSpeaking(false);
    setMuted(false);
  }, [relayTurn]);

  const report = useCallback(
    async (reason: "hangup" | "navigation" | "error" | "microphone_denied") => {
      const id = callId.current;
      if (!id) return;
      callId.current = null;

      const body = JSON.stringify({ callSessionId: id, reason });
      // `keepalive` so the call is closed even when the tab is going away.
      await fetch("/api/assistants/maya/call/end", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => undefined);
    },
    []
  );

  const hangUp = useCallback(() => {
    // Retire the current attempt first: a start still in flight now fails its
    // ownership check and disposes itself instead of connecting behind us.
    generation.current += 1;
    setStatus("ending");
    teardown();
    void report("hangup").finally(() => setStatus("idle"));
  }, [report, teardown]);

  /**
   * Relays what the provider says.
   *
   * Three kinds of event matter. Audio fragments drive the speaking
   * indicator, transcript fragments are fed to the assembler and produce a
   * turn only once it is complete, and a delegation is a request for backend
   * work that the server answers with eve.
   *
   * Everything else is ignored on purpose, and no half-finished transcript is
   * ever persisted — that guarantee now comes from the assembler rather than
   * from the provider declaring a turn done, because Live never does.
   */
  const handleEvent = useCallback(
    async (raw: string) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(raw) as LiveEvent;
      } catch {
        return;
      }

      callbacks.current.onProviderEvent?.(event);

      if (event.type === "session.output_audio.delta") {
        setSpeaking(true);
        if (speakingTimer.current) {
          clearTimeout(speakingTimer.current);
        }
        speakingTimer.current = setTimeout(
          () => setSpeaking(false),
          SPEAKING_IDLE_MS
        );
        return;
      }

      const id = callId.current;
      if (!id) return;

      const delta = deltaOf(event);
      if (delta) {
        const finished = assembler.current.push(delta);
        if (finished) {
          const interrupted =
            finished.role === "assistant" &&
            callbacks.current.shouldMarkTurnInterrupted?.() === true;
          await relayTurn({ ...finished, interrupted });
        }
        return;
      }

      const delegationId = delegationOf(event);
      if (!delegationId) {
        return;
      }

      // The delegation carries no task text, so the conversation goes with it.
      // The turn still being spoken is included: that is usually where the
      // request actually is.
      const answer = await fetch("/api/assistants/maya/call/delegate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          callSessionId: id,
          delegationId,
          transcript: assembler.current
            .context()
            .map((turn) => ({ role: turn.role, text: turn.text })),
        }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);

      const content =
        (answer as { content?: unknown } | null)?.content ??
        "I could not get that just now.";

      channel.current?.send(
        JSON.stringify({
          type: "session.commentary.append",
          event_id: `delegation_${delegationId}`,
          delegation_id: delegationId,
          content: String(content),
        })
      );
    },
    [relayTurn]
  );

  const start = useCallback(async () => {
    // Synchronous, before the first await: two entries can never both proceed.
    const attempt = generation.current + 1;
    generation.current = attempt;
    const owns = () => generation.current === attempt;

    // Anything a previous attempt left behind is released before this one
    // opens a microphone of its own.
    teardown();
    await report("hangup");
    if (!owns()) return;

    setError(null);
    setErrorMessage(null);
    setStatus("requesting-mic");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (cause) {
      const name = (cause as { name?: string })?.name;
      const denied = name === "NotAllowedError" || name === "SecurityError";
      setError(denied ? "microphone_denied" : "microphone_missing");
      setErrorMessage(null);
      setStatus("error");
      void report("microphone_denied");
      return;
    }

    if (!owns()) {
      // Someone else started while the permission prompt was open.
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    microphone.current = stream;
    setStatus("connecting");

    try {
      const connection = new RTCPeerConnection();
      pc.current = connection;

      for (const track of stream.getAudioTracks()) {
        connection.addTrack(track, stream);
      }

      // Maya's voice on a regular call. Attached to the document so echo
      // cancellation can see it. The FaceTime prototype must not play this
      // element: Tavus video is the one audible path, and a muted element is
      // not a proof the browser will keep it silent on every engine.
      const muteProvider = callbacks.current.muteProviderAudio === true;
      let element: HTMLAudioElement | null = null;
      if (!muteProvider) {
        element = document.createElement("audio");
        element.autoplay = true;
        element.hidden = true;
        document.body.append(element);
        audio.current = element;
      }
      connection.ontrack = (event) => {
        if (element) {
          element.srcObject = event.streams[0];
        }
        const track = event.track;
        if (track.kind === "audio") {
          callbacks.current.onRemoteAudioTrack?.(track);
        }
      };

      const data = connection.createDataChannel("oai-events");
      channel.current = data;
      data.addEventListener("message", (event) => {
        void handleEvent(event.data);
      });

      connection.onconnectionstatechange = () => {
        // A superseded attempt's connection must not drive the UI.
        if (!owns()) return;
        const state = connection.connectionState;
        if (state === "connected") {
          setStatus("connected");
        }
        if (state === "failed" || state === "disconnected") {
          teardown();
          setError("connection");
          setErrorMessage(null);
          setStatus("error");
          void report("error");
        }
      };

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (!owns()) {
        connection.close();
        return;
      }

      const response = await fetch(
        callbacks.current.startUrl ?? "/api/assistants/maya/call/start",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sdp: offer.sdp,
            threadId: options.threadId,
            timezone:
              Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          }),
        }
      );

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        teardown();
        setError(response.status === 429 ? "limit" : "connection");
        // A 429 carries a sentence worth showing verbatim; anything else is
        // described by the surface in the user's own language.
        setErrorMessage(response.status === 429 ? detail?.message ?? null : null);
        setStatus("error");
        return;
      }

      const body = (await response.json()) as CallStartResponse;

      if (!owns()) {
        // The call exists on the server now, so it has to be ended there as
        // well as closed here — otherwise it holds the concurrency slot until
        // the sweep.
        connection.close();
        callId.current = body.callSessionId;
        void report("navigation");
        return;
      }

      callId.current = body.callSessionId;
      setThreadId(body.threadId);
      callbacks.current.onStart?.(body);

      limitTimer.current = setTimeout(() => {
        if (!owns()) return;
        generation.current += 1;
        teardown();
        void report("hangup");
        setError("limit");
        setErrorMessage(body.limitMessage ?? null);
        setStatus("error");
      }, Math.max(1, body.maxMinutes) * 60_000);

      await connection.setRemoteDescription({
        type: "answer",
        sdp: body.answerSdp,
      });
      if (!owns()) {
        teardown();
        void report("navigation");
      }
    } catch {
      teardown();
      setError("unknown");
      setErrorMessage(null);
      setStatus("error");
      void report("error");
    }
  }, [handleEvent, options.threadId, report, teardown]);


  const toggleMute = useCallback(() => {
    const tracks = microphone.current?.getAudioTracks() ?? [];
    const next = !muted;
    for (const track of tracks) {
      track.enabled = !next;
    }
    setMuted(next);
  }, [muted]);

  // Navigating away, closing the tab or unmounting all end the call and free
  // the microphone. Without this the browser keeps recording.
  useEffect(() => {
    const onHide = () => {
      generation.current += 1;
      teardown();
      if (callId.current) {
        void report("navigation");
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      onHide();
    };
  }, [report, teardown]);

  return {
    status,
    error,
    errorMessage,
    muted,
    speaking,
    threadId,
    start,
    toggleMute,
    hangUp,
  };
}

/**
 * The browser's half of the OpenAI adapter, kept deliberately thin and kept
 * here rather than in shared code: the server's normaliser is the one that
 * matters, and this exists only so events that mean nothing are dropped before
 * they cost a request.
 */
function deltaOf(event: LiveEvent): TranscriptDelta | null {
  const role =
    event.type === "session.input_transcript.delta"
      ? ("user" as const)
      : event.type === "session.output_transcript.delta"
        ? ("assistant" as const)
        : null;

  if (!role || typeof event.delta !== "string" || event.delta.length === 0) {
    return null;
  }

  const startMs = typeof event.start_ms === "number" ? event.start_ms : 0;
  const endMs = typeof event.end_ms === "number" ? event.end_ms : startMs;

  return { role, text: event.delta, startMs, endMs };
}

function delegationOf(event: LiveEvent): string | null {
  if (event.type !== "session.delegation.created") {
    return null;
  }
  const delegation = event.delegation;
  return delegation?.id && delegation.target === "client"
    ? delegation.id
    : null;
}
