/**
 * Three clocks on one spoken answer.
 *
 * OpenAI finishing generation is not the same as us handing a chunk to Daily,
 * and handing a chunk to Daily is not the same as the user hearing it. Tavus
 * publishes no playback cursor, and Live's transcript timestamps are on the
 * session timeline, not the loudspeaker. This ledger keeps the three tallies
 * separate so a barge-in can stop the face without pretending we know which
 * words were heard.
 *
 * Documented truncation does not close that gap here. Realtime WebSocket
 * clients send `conversation.item.truncate` with `audio_end_ms` of *local*
 * playback. Live WebRTC truncates against the OpenAI media track, which we
 * mute and do not play. A guessed `audio_end_ms` from Tavus energy would
 * write a false cursor into the model's context, so we never send one.
 * If played energy cannot be observed, the answer is persisted as interrupted
 * and excluded from memory extraction.
 */

export type InterruptResult = {
  previousInferenceId: string | null;
  generatedMs: number;
  handedMs: number;
  playedMs: number;
  /** handed − played at the moment of barge-in. Not a word boundary. */
  unplayedMs: number;
};

export type PersistenceVerdict =
  | { interrupted: false }
  | { interrupted: true; reason: "barge_in" | "playback_uncertain" };

const PLAYING_RMS = 0.01;
const DRAINED_MS = 40;

export class PlaybackLedger {
  generatedMs = 0;
  handedMs = 0;
  playedMs = 0;
  inferenceId: string | null = null;
  lastPayloadBytes = 0;
  maxPayloadBytes = 0;
  overLimitCount = 0;
  handedCount = 0;
  maxQueueMs = 0;
  bargeIn = false;
  lastInterruptAt: number | null = null;
  lastSilenceMs: number | null = null;
  extraDelayMs: number | null = null;
  generatedStartedAt: number | null = null;
  playedStartedAt: number | null = null;
  playing = false;
  #pending = new Uint8Array(0) as Uint8Array;
  #interruptStartedAt: number | null = null;
  #lastPlayedAt: number | null = null;
  /** Drop leftover OpenAI PCM until the old utterance has gone quiet. */
  #dropUntilQuiet = false;
  #heardQuiet = false;

  beginUtterance(id: string): void {
    this.inferenceId = id;
    this.generatedMs = 0;
    this.handedMs = 0;
    this.playedMs = 0;
    this.bargeIn = false;
    this.generatedStartedAt = null;
    this.playedStartedAt = null;
    this.#pending = new Uint8Array(0) as Uint8Array;
    this.#lastPlayedAt = null;
    this.#dropUntilQuiet = false;
    this.#heardQuiet = false;
  }

  /**
   * Whether this PCM still belongs on the current utterance.
   *
   * After barge-in, OpenAI's WebRTC track can keep delivering the cancelled
   * response for a few hundred milliseconds. That audio must not start a new
   * inference id. We wait for a quiet gap; the next energetic buffer is a
   * new answer.
   */
  acceptGenerated(energy: number): boolean {
    if (this.#dropUntilQuiet) {
      if (energy < PLAYING_RMS) {
        this.#heardQuiet = true;
        return false;
      }
      if (!this.#heardQuiet) {
        return false;
      }
      this.#dropUntilQuiet = false;
      this.#heardQuiet = false;
    }
    if (energy < PLAYING_RMS && this.generatedMs === 0 && this.inferenceId === null) {
      return false;
    }
    return true;
  }

  recordGenerated(pcm: Uint8Array, now = Date.now()): Uint8Array {
    if (this.generatedStartedAt === null) {
      this.generatedStartedAt = now;
    }
    this.generatedMs += durationMs(pcm.length);
    this.#pending = concat(this.#pending, pcm) as Uint8Array;
    return this.#pending;
  }

  takeChunk(sizeBytes: number): Uint8Array | null {
    if (this.#pending.length < sizeBytes) {
      return null;
    }
    const chunk = this.#pending.slice(0, sizeBytes) as Uint8Array;
    this.#pending = this.#pending.slice(sizeBytes) as Uint8Array;
    return chunk;
  }

  flushPending(): Uint8Array {
    const pending = this.#pending;
    this.#pending = new Uint8Array(0) as Uint8Array;
    return pending;
  }

  recordHanded(pcm: Uint8Array, bytes: number): void {
    this.handedMs += durationMs(pcm.length);
    this.handedCount += 1;
    this.lastPayloadBytes = bytes;
    if (bytes > this.maxPayloadBytes) {
      this.maxPayloadBytes = bytes;
    }
    const queued = this.queueMs();
    if (queued > this.maxQueueMs) {
      this.maxQueueMs = queued;
    }
  }

  recordOverLimit(): void {
    this.overLimitCount += 1;
  }

  recordPlayed(energy: number, now = Date.now()): void {
    const wasPlaying = this.playing;
    this.playing = energy >= PLAYING_RMS;
    if (this.playing) {
      if (this.#lastPlayedAt !== null) {
        this.playedMs += now - this.#lastPlayedAt;
      }
      this.#lastPlayedAt = now;
      if (this.playedStartedAt === null) {
        this.playedStartedAt = now;
        if (this.generatedStartedAt !== null && this.extraDelayMs === null) {
          this.extraDelayMs = now - this.generatedStartedAt;
        }
      }
    } else {
      this.#lastPlayedAt = null;
      if (wasPlaying && this.#interruptStartedAt !== null) {
        this.lastSilenceMs = now - this.#interruptStartedAt;
        this.#interruptStartedAt = null;
      }
    }
  }

  /** How much we have handed Daily that has not yet shown up as energy. */
  queueMs(): number {
    return Math.max(0, this.handedMs - this.playedMs);
  }

  interrupt(now = Date.now()): InterruptResult {
    const previousInferenceId = this.inferenceId;
    const result: InterruptResult = {
      previousInferenceId,
      generatedMs: this.generatedMs,
      handedMs: this.handedMs,
      playedMs: this.playedMs,
      unplayedMs: this.queueMs() + durationMs(this.#pending.length),
    };
    this.bargeIn = true;
    this.lastInterruptAt = now;
    this.#interruptStartedAt = now;
    this.#pending = new Uint8Array(0) as Uint8Array;
    this.inferenceId = null;
    this.#dropUntilQuiet = true;
    this.#heardQuiet = false;
    return result;
  }

  /**
   * Whether this assistant turn should be stored as delivered.
   *
   * Completed only when we saw Tavus energy, the Daily hand-off drained, and
   * the user never talked over it. Anything else is uncertain: we have no
   * sample-accurate playback position from either provider.
   */
  persistence(): PersistenceVerdict {
    if (this.bargeIn) {
      return { interrupted: true, reason: "barge_in" };
    }
    if (this.playedStartedAt === null || this.queueMs() > DRAINED_MS) {
      return { interrupted: true, reason: "playback_uncertain" };
    }
    return { interrupted: false };
  }

  snapshot(): {
    generatedMs: number;
    handedMs: number;
    playedMs: number;
    queueMs: number;
    lastPayloadBytes: number;
    maxPayloadBytes: number;
    overLimitCount: number;
    handedCount: number;
    maxQueueMs: number;
    extraDelayMs: number | null;
    lastSilenceMs: number | null;
    inferenceId: string | null;
    bargeIn: boolean;
  } {
    return {
      generatedMs: this.generatedMs,
      handedMs: this.handedMs,
      playedMs: this.playedMs,
      queueMs: this.queueMs(),
      lastPayloadBytes: this.lastPayloadBytes,
      maxPayloadBytes: this.maxPayloadBytes,
      overLimitCount: this.overLimitCount,
      handedCount: this.handedCount,
      maxQueueMs: this.maxQueueMs,
      extraDelayMs: this.extraDelayMs,
      lastSilenceMs: this.lastSilenceMs,
      inferenceId: this.inferenceId,
      bargeIn: this.bargeIn,
    };
  }
}

function durationMs(byteLength: number, sampleRate = 16_000): number {
  return (byteLength / 2 / sampleRate) * 1000;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
