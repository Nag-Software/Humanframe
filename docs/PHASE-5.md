# Phase 5 — Call

Browser voice calls with Maya, over OpenAI Realtime and WebRTC. Built so that
phase 6 can add Tavus video without touching Humanframe's backend.

## Preflight, measured

Verified against the live API on 2026-09-15, not from memory:

| Question | Answer | How |
| --- | --- | --- |
| Model id | `gpt-realtime-2.1` | `POST /v1/realtime/client_secrets` accepted it and echoed it back. `gpt-live-1` also exists on this key but is undocumented; the GA id is what we ship. |
| Session config | Accepted verbatim | Our exact object — `semantic_vad` with `interrupt_response`, `gpt-4o-mini-transcribe`, voice `marin`, three tools — came back unchanged. |
| Browser authorization | SDP proxy | `POST /v1/realtime/calls` (multipart `sdp` + `session`) answers `Location: /v1/realtime/calls/{id}` and an SDP body. A real Chrome offer was exchanged for a valid answer with audio and data channel, and no credential in the answer. |
| Server-side tools | Round trip works | Over the WebSocket transport, which speaks the identical event protocol: tool called, answered, audio produced, Norwegian throughout. |
| Interruption | `status: "incomplete"` | Cancelled a response mid-audio; the item reported `incomplete` and carried only the words actually produced. |

**Hosting: no deviation.** No long-lived server connection is needed. The
server touches the provider exactly once per call, to trade the offer for an
answer; media and events flow browser↔OpenAI. This fits Next.js on Vercel as it
stands.

We deliberately did **not** take the sideband WebSocket
(`wss://api.openai.com/v1/realtime?call_id=…`). It would mean a persistent
server socket for the length of every call, which is the one thing this hosting
setup cannot hold.

## Why the browser relays tool calls

Realtime delivers tool calls to whoever holds the data channel, which is the
browser. It posts them to `/api/assistants/maya/call/tool` and posts the result
back. The browser is a **transport, not a participant**:

- workspace, assistant, thread and user come from the `call_sessions` row
  written when the call was authorised;
- no code path reads scope from a tool argument — test 23–27 drives a hostile
  argument set (another tenant's workspace and user, a foreign thread) and the
  commitment still lands in the caller's own workspace and thread;
- only three tool names resolve; anything else returns an error, never an action;
- Realtime has no database credential and no route to Supabase.

## Architecture

```
components/maya/call/          browser: microphone, peer connection, relay
app/api/assistants/maya/call/  authenticated routes: start, tool, turn, end
server/call/binding.ts         who a call is bound to          — provider-neutral
server/call/context.ts         Maya's instructions + memory    — provider-neutral
server/call/tools.ts           what a tool does                — provider-neutral
server/call/transcript.ts      how a turn is persisted/learned — provider-neutral
server/call/limits.ts          what is actually enforced       — provider-neutral
server/call/openai-realtime.ts the only file that knows OpenAI's wire format
agent/channels/internal.ts     the one thing only eve can do: start a timer
```

### The session binding

`call_sessions` holds the canonical Humanframe `thread_id`, `workspace_id`,
`assistant_id` and `user_id`. The provider's own session id is
`provider_call_id` — internal, never rendered, and deliberately **not**
`threads.eve_session_id`. A call is not an eve session; conflating them would
let a call take over a chat thread.

### Context

The same `agent/instructions.md` and the same `buildContextPackage` the chat
runtime uses, plus a short spoken-style addendum and an explicit statement of
now and the user's timezone (a spoken "Friday" has to become an absolute instant
before `schedule_followup` will take it). Chat history is not poured in:
Realtime keeps the conversation it is having.

Realtime leads the conversation. No call turn goes through eve, so no call
produces a second assistant answer.

### Transcripts

Providers agree that a turn has a stable id, a speaker, words and an end. That
is `CallTurn`, and it is all the persistence path knows.

`record_call_turn` writes the `call_turns` row and its `messages` projection in
one statement. The `call_turns` row is the idempotency anchor: it keeps the
timestamp of the first sighting and the message is written with it, so a
repeated event, a reconnect or a late flush conflicts on the same key. Partial
transcripts never reach it. Source ids are namespaced `call:<provider>:<id>`, so
two providers cannot collide.

An interrupted answer is recorded with `status: 'interrupted'` and
`metadata.call.interrupted`, and is excluded from memory extraction — the user
never heard those words, so they are not treated as delivered.

Hang-up is not a persistence point. Every turn is durable when it finishes.

### Memory

`extractCandidates` / `storeCandidates` / `mirrorFactsIntoMemories`, exactly as
the chat hook uses them, run once per exchange — gated on the persist actually
having created the row, so a replay learns nothing twice.

### Commitments, and the one asymmetry

A commitment made out loud is the same row, on the same detached
`commitmentTimer`, delivered to the same thread as one made in chat.

Starting that timer is the single thing a Next.js route cannot do: the
`workflow` module is supplied by eve's bundler and does not exist in the Next
build. So `agent/channels/internal.ts` serves
`POST /eve/v1/internal/commitments/timer`, authenticated with the phase 4 OIDC
check (right project, right environment, machine principal, token read fresh at
call time), and the Call route asks it to start the clock. The route takes only
a commitment id, re-reads the row, and refuses anything not `scheduled` — a
caller that can prove it is this deployment still cannot describe whose
commitment gets a clock.

It is mounted under `/eve/v1/` because `withEve` rewrites exactly that one
source into the eve application; a route outside the prefix is unreachable.

If the start fails, the row is still committed and the daily heartbeat is the
backstop — **which can mean up to about a day's delay.** That is the same
trade phase 4.1 documents for notifications.

## What is actually enforced

| Limit | Value | Enforced |
| --- | --- | --- |
| `CALL_MAX_PER_DAY` | 20 | Server, before a call is created (rolling 24h, per user) |
| `CALL_MAX_CONCURRENT` | 1 | Server, per workspace |
| `CALL_MAX_MINUTES` | 15 | Server refuses to serve tool calls past it, and sweeps the row |

The browser shows no countdown, because a client timer is not a cost ceiling:
the page can be closed or edited and the call would continue. What genuinely
bounds spend is the number of streams the server will open, which is the daily
and concurrency caps. The provider bills the media path directly; Humanframe
caps what it starts and keeps serving, and cannot cut an in-flight audio stream
off to the second.

`CALL_ENABLED` is off by default, server-side. `NEXT_PUBLIC_CALL_ENABLED` only
decides whether the button is offered — turning it on alone cannot place a call.

No key and no transcript reaches a log line: tool logs carry the tool name and
outcome, never arguments or output.

## Tests

`pnpm test:call` — 48 deterministic checks, no provider and no browser:
auth and tenant isolation (1–7), session and thread binding (8–10), transcript
dedup, partials and interruption (11–19), tool scope and idempotency (20–32),
no email for ordinary call replies (33), cleanup and end states (34–35),
provider-neutrality — the same backend functions driven as `tavus` with no
OpenAI event in sight (36–39), and the adapter in isolation (40–48).

## One failure mode worth not reintroducing

`start()` is async and can be entered twice before React re-renders: Strict Mode
double-invokes the mount effect in development, and the retry button can land on
a connection that is still opening. **A `status` check cannot guard this** —
both entries close over the same stale value, so both proceed. The second then
overwrites `pc.current`, `audio.current` and `callId.current`, and the first
call is left fully alive with nothing referencing it.

That orphan is worse than a leak. It keeps talking, hang-up cannot reach it, and
it holds the concurrency slot until the sweep. Two live sessions also play into
the same speakers and listen through the same microphone, so each hears the
other, `semantic_vad` fires, and they greet each other indefinitely.

The guard is therefore a **ref**, incremented synchronously before the first
await and re-checked after every one; an attempt that has lost ownership
disposes what it just built, including ending a call the server has already
created. `hangUp` and unmount retire the generation too, so a start still in
flight cannot connect behind them.

The audio element is attached to the document for the same class of reason: a
detached element is not reliably tracked by the browser's echo canceller, and an
output the canceller cannot see is an output she hears herself through.

Verified in a real browser against the dev server, with `getUserMedia` stubbed
to a synthetic stream so no hardware is needed: one click produces exactly one
microphone prompt, one `/call/start`, one `<audio>` element and one
`call_sessions` row; hang-up removes the element, posts one `/call/end`, and
leaves the row `ended`/`hangup`.

## Phase 6: what Tavus reuses, what it must build

**Reuses unchanged** (none of these import OpenAI anything):

- `createCallSession` / `loadCallBinding` / `endCallSession` — add `'tavus'` to
  the provider check; it is already in the schema and already tested.
- `buildCallInstructions` — identity, memory, time and timezone.
- `CALL_TOOLS` + `executeCallTool` — the tool contract and its scope rules.
- `recordCallTurn` + `learnFromCallExchange` — transcripts and memory.
- `checkCallLimits` / `reapStaleCalls` — spend.
- `call_sessions` / `call_turns` / `record_call_turn`.

**Must be built, Tavus-specific:**

- an adapter that translates Tavus events into `CallTurn` and into
  `{name, callId, args}` — the shape `turnFromEvent` / `toolCallFromEvent`
  produce;
- whatever Tavus authorization is (do not assume it mints an SDP answer, or that
  it speaks OpenAI Realtime, the Responses API, or eve's session protocol);
- the video surface, and the persona/replica configuration;
- a decision about where its tool calls arrive, and a route for them if the
  relay is not the browser.

Identical voice between Call and video is not a phase 5 acceptance criterion and
was not attempted.

## Not in this phase

No LiveKit, no SIP, no new providers. No approval bridge: risky actions stay in
chat, and Maya is told to say so and offer to continue there. No raw audio is
stored. The chat UI is unchanged.
