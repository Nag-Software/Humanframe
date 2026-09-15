"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One voice call, from the browser's side.
 *
 * The browser's whole job is transport: it owns the microphone, the peer
 * connection and the data channel, and it relays two kinds of event to the
 * server — a finished turn, and a tool call. It holds no credential, decides
 * nothing about scope, and never touches a database.
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

type StartResponse = {
  callSessionId: string;
  threadId: string;
  answerSdp: string;
  maxMinutes: number;
};

export function useCall(options: { threadId: string | null }): UseCall {
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

  /** Releases every resource. Safe to call repeatedly. */
  const teardown = useCallback(() => {
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
  }, []);

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
    setStatus("ending");
    teardown();
    void report("hangup").finally(() => setStatus("idle"));
  }, [report, teardown]);

  /**
   * Relays what the provider says.
   *
   * Two event types matter and the rest are ignored on purpose: a partial
   * transcript is never persisted and never acted on, so nothing half-said can
   * become a message or a commitment.
   */
  const handleEvent = useCallback(async (raw: string) => {
    let event: ProviderEvent;
    try {
      event = JSON.parse(raw) as ProviderEvent;
    } catch {
      return;
    }

    if (event.type === "response.output_audio.delta") {
      setSpeaking(true);
      return;
    }
    if (event.type === "response.done" || event.type === "response.cancelled") {
      setSpeaking(false);
    }

    const id = callId.current;
    if (!id) return;

    const turn = turnOf(event);
    if (turn) {
      // Belt and braces: the server is idempotent, and this stops the same
      // event being relayed twice in the first place.
      if (relayed.current.has(turn.sourceId)) return;
      relayed.current.add(turn.sourceId);

      await fetch("/api/assistants/maya/call/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callSessionId: id, ...turn }),
        keepalive: true,
      }).catch(() => undefined);
      return;
    }

    const call = toolCallOf(event);
    if (call) {
      const result = await fetch("/api/assistants/maya/call/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callSessionId: id, ...call }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);

      const output = (result as { output?: unknown } | null)?.output ?? {
        error: "That did not work.",
      };

      channel.current?.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify(output),
          },
        })
      );
      channel.current?.send(JSON.stringify({ type: "response.create" }));
    }
  }, []);

  const start = useCallback(async () => {
    if (status !== "idle" && status !== "error") {
      return;
    }

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

    microphone.current = stream;
    setStatus("connecting");

    try {
      const connection = new RTCPeerConnection();
      pc.current = connection;

      for (const track of stream.getAudioTracks()) {
        connection.addTrack(track, stream);
      }

      // Maya's voice. Created here rather than in the tree so teardown owns it.
      const element = document.createElement("audio");
      element.autoplay = true;
      audio.current = element;
      connection.ontrack = (event) => {
        element.srcObject = event.streams[0];
      };

      const data = connection.createDataChannel("oai-events");
      channel.current = data;
      data.addEventListener("message", (event) => {
        void handleEvent(event.data);
      });

      connection.onconnectionstatechange = () => {
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

      const response = await fetch("/api/assistants/maya/call/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sdp: offer.sdp,
          threadId: options.threadId,
          timezone:
            Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        }),
      });

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

      const body = (await response.json()) as StartResponse;
      callId.current = body.callSessionId;
      setThreadId(body.threadId);

      await connection.setRemoteDescription({
        type: "answer",
        sdp: body.answerSdp,
      });
    } catch {
      teardown();
      setError("unknown");
      setErrorMessage(null);
      setStatus("error");
      void report("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.threadId, report, status, teardown]);


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
      if (callId.current) {
        teardown();
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

type ProviderEvent = {
  type?: string;
  item_id?: string;
  transcript?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  item?: { id?: string; role?: string; status?: string; content?: unknown[] };
};

type RelayedTurn = {
  sourceId: string;
  role: "user" | "assistant";
  text: string;
  interrupted?: boolean;
};

/**
 * The browser's half of the OpenAI adapter, kept deliberately thin and kept
 * here rather than in shared code: the server's normaliser is the one that
 * matters, and this exists only so partial events are dropped before they cost
 * a request.
 */
function turnOf(event: ProviderEvent): RelayedTurn | null {
  if (
    event.type === "conversation.item.input_audio_transcription.completed" &&
    event.item_id &&
    typeof event.transcript === "string"
  ) {
    const text = event.transcript.trim();
    return text ? { sourceId: event.item_id, role: "user", text } : null;
  }

  if (
    event.type === "conversation.item.done" &&
    event.item?.id &&
    event.item.role === "assistant"
  ) {
    const text = (event.item.content ?? [])
      .map((part) => {
        const record = part as { transcript?: unknown; text?: unknown };
        if (typeof record.transcript === "string") return record.transcript;
        if (typeof record.text === "string") return record.text;
        return "";
      })
      .join(" ")
      .trim();

    if (!text) return null;

    return {
      sourceId: event.item.id,
      role: "assistant",
      text,
      interrupted: event.item.status === "incomplete",
    };
  }

  return null;
}

function toolCallOf(
  event: ProviderEvent
): { name: string; callId: string; args: unknown } | null {
  if (
    event.type !== "response.function_call_arguments.done" ||
    !event.name ||
    !event.call_id
  ) {
    return null;
  }

  let args: unknown = {};
  try {
    args = event.arguments ? JSON.parse(event.arguments) : {};
  } catch {
    args = {};
  }

  return { name: event.name, callId: event.call_id, args };
}
