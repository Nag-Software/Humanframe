/**
 * Spoken turns, assembled from fragments.
 *
 * The Live API has no event that marks a transcript finished — there are only
 * deltas carrying `start_ms` and `end_ms` — so the boundary between one turn
 * and the next is ours to draw. Measured against the API on 2026-09-15, and
 * the reason the older Realtime code could simply wait for a `completed` event
 * and this cannot.
 *
 * Two things close a turn: the other speaker starting, and a silence longer
 * than `TURN_GAP_MS` inside one speaker's own stream. Neither is a guess about
 * meaning — both are observable in the timestamps.
 *
 * Deliberately pure and import-free: the browser runs it, and a test can drive
 * it without a provider, a network or a clock.
 */
export type TranscriptDelta = {
  role: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
};

export type AssembledTurn = {
  /** Stable for the life of the turn, so re-relaying one is idempotent. */
  sourceId: string;
  role: "user" | "assistant";
  text: string;
};

export const TURN_GAP_MS = 1_500;

/** How much conversation a delegation is allowed to see. */
const CONTEXT_TURNS = 12;
const HISTORY_LIMIT = 40;

type OpenTurn = {
  role: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
};

export class TurnAssembler {
  #open: OpenTurn | null = null;
  #history: AssembledTurn[] = [];

  /**
   * Feeds one delta in. Returns the turn this delta *closed*, if any — never
   * the turn it belongs to, which is still being spoken.
   */
  push(delta: TranscriptDelta): AssembledTurn | null {
    const open = this.#open;
    const closed =
      open &&
      (open.role !== delta.role || delta.startMs - open.endMs > TURN_GAP_MS)
        ? this.#close()
        : null;

    if (this.#open) {
      this.#open.text += delta.text;
      this.#open.endMs = Math.max(this.#open.endMs, delta.endMs);
    } else {
      this.#open = {
        role: delta.role,
        text: delta.text,
        startMs: delta.startMs,
        endMs: delta.endMs,
      };
    }

    return closed;
  }

  /** Closes whatever is still open — at hang-up, or when the session ends. */
  flush(): AssembledTurn | null {
    return this.#close();
  }

  /**
   * The conversation so far, including the turn still in progress.
   *
   * A delegation fires while someone is mid-sentence, and the request that
   * triggered it is usually *in* that unfinished turn, so leaving it out would
   * hand the backend a question it cannot see.
   */
  context(limit = CONTEXT_TURNS): AssembledTurn[] {
    const open = this.#open ? [freeze(this.#open)] : [];
    return [...this.#history, ...open]
      .filter((turn) => turn.text.length > 0)
      .slice(-limit);
  }

  #close(): AssembledTurn | null {
    const open = this.#open;
    this.#open = null;

    if (!open || open.text.trim().length === 0) {
      return null;
    }

    const turn = freeze(open);
    this.#history.push(turn);
    if (this.#history.length > HISTORY_LIMIT) {
      this.#history.shift();
    }
    return turn;
  }
}

function freeze(open: OpenTurn): AssembledTurn {
  return {
    sourceId: `${open.role}:${open.startMs}`,
    role: open.role,
    text: open.text.trim(),
  };
}
