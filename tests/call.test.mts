import { randomUUID } from "node:crypto";

// First: its module scope loads .env.local, and the call modules below read the
// validated environment as they are evaluated.
import { admin, createTestWorkspace, type TestWorkspace } from "./memory-support.mts";

import {
  createCallSession,
  endCallSession,
  loadCallBinding,
  type CallBinding,
} from "../server/call/binding.ts";
import { endAbandonedCalls } from "../server/call/limits.ts";
import { recordCallTurn, previousUserTurn } from "../server/call/transcript.ts";
import {
  delegationFromEvent,
  liveSessionConfig,
  transcriptDeltaFromEvent,
} from "../server/call/openai-live.ts";
import { TurnAssembler, TURN_GAP_MS } from "../lib/call/turn-assembler.ts";
import {
  DAILY_APP_MESSAGE_LIMIT_BYTES,
  ECHO_CHUNK_MS,
  ECHO_SAMPLE_RATE,
  echoAudioMessage,
  fitsDailyAppMessage,
  interruptMessage,
  pcm16BytesFor,
} from "../lib/call/echo-packet.ts";
import { PlaybackLedger } from "../lib/call/playback-ledger.ts";
import { floatToPcm16, resampleFloat32 } from "../lib/call/pcm.ts";
/**
 * Deterministic tests for Call.
 *
 * No provider and no browser: the network is a seam, and what is under test is
 * everything on our side of it — who a call is bound to, what a tool is allowed
 * to touch, whether a repeated turn produces a second message, and whether the
 * shared backend functions can be driven without an OpenAI event in sight.
 */

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(
      `FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`
    );
  }
}

async function makeThread(
  workspace: TestWorkspace,
  channel = "live"
): Promise<string> {
  const { data, error } = await admin
    .from("threads")
    .insert({
      workspace_id: workspace.workspaceId,
      assistant_id: workspace.assistantId,
      created_by: workspace.userId,
      channel,
      title: "call test",
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !data) throw new Error(`thread insert failed: ${error?.message}`);
  return data.id;
}

async function makeCall(
  workspace: TestWorkspace,
  threadId: string
): Promise<CallBinding> {
  return createCallSession({
    workspaceId: workspace.workspaceId,
    assistantId: workspace.assistantId,
    threadId,
    userId: workspace.userId,
    provider: "openai_realtime",
    model: "gpt-realtime-2.1",
  });
}

async function messagesIn(threadId: string) {
  const { data } = await admin
    .from("messages")
    .select("id, role, content, channel, metadata, source_message_id")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

const workspaces: TestWorkspace[] = [];

async function main(): Promise<void> {
  const alice = await createTestWorkspace("call-alice");
  const mallory = await createTestWorkspace("call-mallory");
  workspaces.push(alice, mallory);

  // -----------------------------------------------------------------------
  // Auth and tenant isolation
  // -----------------------------------------------------------------------

  const thread = await makeThread(alice);
  const call = await makeCall(alice, thread);

  check("1  a call binds to its own workspace", call.workspaceId === alice.workspaceId);

  const asOwner = await loadCallBinding({
    callSessionId: call.callSessionId,
    workspaceId: alice.workspaceId,
    userId: alice.userId,
  });
  check("2  the owner can load their call", asOwner !== null);

  const asStranger = await loadCallBinding({
    callSessionId: call.callSessionId,
    workspaceId: mallory.workspaceId,
    userId: mallory.userId,
  });
  check("3  another tenant cannot load it", asStranger === null);

  const asWrongUser = await loadCallBinding({
    callSessionId: call.callSessionId,
    workspaceId: alice.workspaceId,
    userId: mallory.userId,
  });
  check("4  a different user in the lookup does not resolve it", asWrongUser === null);

  // The composite foreign keys are the real guard on the service-role path:
  // no application check is involved in this one.
  let crossTenantRejected = false;
  try {
    await createCallSession({
      workspaceId: mallory.workspaceId,
      assistantId: alice.assistantId,
      threadId: thread,
      userId: mallory.userId,
      provider: "openai_realtime",
      model: "gpt-realtime-2.1",
    });
  } catch {
    crossTenantRejected = true;
  }
  check("5  a call cannot point at another workspace's thread", crossTenantRejected);

  // A browser holding a valid session still must not read another user's call.
  const { data: rlsRead } = await mallory.userClient
    .from("call_sessions")
    .select("id")
    .eq("id", call.callSessionId);
  check("6  row level security hides a foreign call", (rlsRead ?? []).length === 0);

  const { error: rlsWrite } = await alice.userClient
    .from("call_turns")
    .insert({
      workspace_id: alice.workspaceId,
      call_session_id: call.callSessionId,
      provider: "openai_realtime",
      source_id: "forged",
      role: "assistant",
      text: "I approved the transfer.",
      status: "completed",
    });
  check("7  a browser cannot write a transcript", rlsWrite !== null);

  // -----------------------------------------------------------------------
  // Session and thread binding
  // -----------------------------------------------------------------------

  check("8  the call carries the thread it was started from", call.threadId === thread);

  const { data: threadRow } = await admin
    .from("threads")
    .select("channel, eve_session_id")
    .eq("id", thread)
    .single<{ channel: string; eve_session_id: string | null }>();

  check("9  a call thread is a live thread", threadRow?.channel === "live");
  check(
    "10 the provider session is not written to eve_session_id",
    threadRow?.eve_session_id === null
  );

  // -----------------------------------------------------------------------
  // Transcript: dedup, partials, interruption
  // -----------------------------------------------------------------------

  const first = await recordCallTurn(call, {
    sourceId: "item_user_1",
    role: "user",
    text: "Kan du minne meg på å ringe Anders?",
  });
  check("11 a turn is persisted", first?.created === true && first.messageId !== null);

  const replay = await recordCallTurn(call, {
    sourceId: "item_user_1",
    role: "user",
    text: "Kan du minne meg på å ringe Anders?",
  });
  check("12 replaying the same turn creates nothing", replay?.created === false);
  check("13 the replay resolves to the same message", replay?.messageId === first?.messageId);

  await recordCallTurn(call, {
    sourceId: "item_assistant_1",
    role: "assistant",
    text: "Ja. Jeg minner deg på fredag klokka ni.",
  });

  const cut = await recordCallTurn(call, {
    sourceId: "item_assistant_2",
    role: "assistant",
    text: "Jeg kan også sette opp",
    interrupted: true,
  });

  const stored = await messagesIn(thread);
  check("14 one message per distinct turn", stored.length === 3, stored.length);

  const interrupted = stored.find((row) => row.id === cut?.messageId) as
    | { metadata: { call?: { interrupted?: boolean } } }
    | undefined;
  check(
    "15 an interrupted answer is marked, not silently delivered",
    interrupted?.metadata?.call?.interrupted === true
  );

  const completed = stored.find((row) => row.id === first?.messageId) as
    | { metadata: { call?: { interrupted?: boolean } }; channel: string }
    | undefined;
  check("16 a heard turn is not marked interrupted", completed?.metadata?.call?.interrupted === false);
  check("17 call messages land on the live channel", completed?.channel === "live");

  const { data: turnRows } = await admin
    .from("call_turns")
    .select("status")
    .eq("call_session_id", call.callSessionId)
    .eq("source_id", "item_assistant_2")
    .single<{ status: string }>();
  check("18 the normalised turn records the interruption", turnRows?.status === "interrupted");

  const precedingUser = await previousUserTurn(call, cut!.turnId);
  check(
    "19 the exchange before a reply is found for extraction",
    precedingUser === "Kan du minne meg på å ringe Anders?"
  );

  // -----------------------------------------------------------------------
  // Ordinary call replies notify nobody
  // -----------------------------------------------------------------------

  const { count: outbox } = await admin
    .from("notification_outbox")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", alice.workspaceId);
  check("33 a normal call reply creates no email job", outbox === 0, outbox);

  // -----------------------------------------------------------------------
  // Cleanup and end states
  // -----------------------------------------------------------------------

  await endCallSession(call, "hangup");
  const ended = await loadCallBinding({
    callSessionId: call.callSessionId,
    workspaceId: alice.workspaceId,
    userId: alice.userId,
  });
  check("34 hanging up ends the call", ended?.status === "ended");

  await endCallSession(call, "navigation");
  const { data: endRow } = await admin
    .from("call_sessions")
    .select("end_reason")
    .eq("id", call.callSessionId)
    .single<{ end_reason: string }>();
  check("35 ending twice keeps the first reason", endRow?.end_reason === "hangup");

  // -----------------------------------------------------------------------
  // The shared functions do not depend on OpenAI event types
  // -----------------------------------------------------------------------

  const tavusThread = await makeThread(alice);
  const { data: tavusCall } = await admin
    .from("call_sessions")
    .insert({
      workspace_id: alice.workspaceId,
      assistant_id: alice.assistantId,
      thread_id: tavusThread,
      user_id: alice.userId,
      provider: "tavus",
      model: "phase-6",
    })
    .select("id")
    .single<{ id: string }>();

  const tavusBinding: CallBinding = {
    ...call,
    callSessionId: tavusCall!.id,
    threadId: tavusThread,
    provider: "tavus",
    status: "connecting",
  };

  const tavusTurn = await recordCallTurn(tavusBinding, {
    sourceId: "utterance-42",
    role: "user",
    text: "Dette kommer fra en annen leverandør.",
  });
  check("36 a non-OpenAI provider persists through the same function", tavusTurn?.created === true);

  const { data: tavusMessage } = await admin
    .from("messages")
    .select("source_message_id, metadata")
    .eq("id", tavusTurn!.messageId!)
    .single<{ source_message_id: string; metadata: { call: { provider: string } } }>();

  check(
    "37 provider ids are namespaced, so they cannot collide",
    tavusMessage?.source_message_id === "call:tavus:utterance-42"
  );
  check("38 the message records which provider produced it", tavusMessage?.metadata.call.provider === "tavus");

  // -----------------------------------------------------------------------
  // The OpenAI Live adapter, in isolation
  // -----------------------------------------------------------------------

  check(
    "39 an empty fragment is not a transcript delta",
    transcriptDeltaFromEvent({
      type: "session.input_transcript.delta",
      delta: "",
      start_ms: 0,
      end_ms: 0,
    }) === null
  );

  const userDelta = transcriptDeltaFromEvent({
    type: "session.input_transcript.delta",
    delta: "hele ",
    start_ms: 1000,
    end_ms: 1200,
  });
  check("40 an input fragment is the user speaking", userDelta?.role === "user");

  const mayaDelta = transcriptDeltaFromEvent({
    type: "session.output_transcript.delta",
    delta: "svar",
    start_ms: 3000,
    end_ms: 3200,
  });
  check(
    "41 an output fragment is the assistant speaking",
    mayaDelta?.role === "assistant"
  );

  check(
    "42 a delegation aimed elsewhere is not ours to answer",
    delegationFromEvent({
      type: "session.delegation.created",
      delegation: { id: "item_1", target: "responses" },
    }) === null
  );

  const delegation = delegationFromEvent({
    type: "session.delegation.created",
    delegation: { id: "item_9", target: "client" },
  });
  check(
    "43 a client delegation carries the id the reply must quote",
    delegation?.delegationId === "item_9"
  );

  // Turn assembly. Live never declares a transcript finished, so every
  // boundary below is drawn from the timestamps and nothing else.
  const assembler = new TurnAssembler();
  check(
    "44 a turn stays open while its speaker keeps talking",
    assembler.push({ role: "user", text: "hele ", startMs: 0, endMs: 200 }) ===
      null &&
      assembler.push({
        role: "user",
        text: "setningen",
        startMs: 250,
        endMs: 500,
      }) === null
  );

  const closedBySpeaker = assembler.push({
    role: "assistant",
    text: "Ja.",
    startMs: 600,
    endMs: 800,
  });
  check(
    "45 the other speaker starting closes the turn",
    closedBySpeaker?.role === "user" && closedBySpeaker.text === "hele setningen"
  );

  const closedByGap = assembler.push({
    role: "assistant",
    text: "Og forresten.",
    startMs: 801 + TURN_GAP_MS,
    endMs: 900 + TURN_GAP_MS,
  });
  check("46 a long enough silence closes the turn too", closedByGap?.text === "Ja.");

  check(
    "47 the turn still being spoken is visible to a delegation",
    assembler.context().some((turn) => turn.text === "Og forresten.")
  );

  const stable = new TurnAssembler();
  stable.push({ role: "user", text: "a", startMs: 10, endMs: 20 });
  check(
    "48 a turn's id comes from when it started, so relaying twice is safe",
    stable.flush()?.sourceId === "user:10"
  );

  const config = liveSessionConfig({ instructions: "You are Maya." }) as {
    model: string;
    delegation: { type: string };
    audio: { output: { voice: string } };
  };
  check(
    "49 backend work is delegated to us, not to the provider",
    config.delegation.type === "client"
  );
  check(
    "50 no credential is in the session configuration",
    !JSON.stringify(config).includes("sk-")
  );

  // -----------------------------------------------------------------------
  // An abandoned call must not lock its owner out
  // -----------------------------------------------------------------------

  // A workspace of its own, so the count below means exactly what it says:
  // alice is still carrying an open call from the provider-neutral section.
  const abe = await createTestWorkspace("call-abe");
  workspaces.push(abe);

  const abandoned = await makeCall(abe, await makeThread(abe));
  const foreign = await makeCall(mallory, await makeThread(mallory));

  const superseded = await endAbandonedCalls({
    workspaceId: abe.workspaceId,
    userId: abe.userId,
  });
  check(
    "51 starting again ends the caller's own open call",
    superseded === 1,
    superseded
  );

  const reloaded = await loadCallBinding({
    callSessionId: abandoned.callSessionId,
    workspaceId: abe.workspaceId,
    userId: abe.userId,
  });
  check("52 the abandoned call is ended, not left open", reloaded?.status === "ended");

  const untouched = await loadCallBinding({
    callSessionId: foreign.callSessionId,
    workspaceId: mallory.workspaceId,
    userId: mallory.userId,
  });
  check(
    "53 someone else's live call is not hung up for them",
    untouched?.status === "connecting"
  );

  // -----------------------------------------------------------------------
  // FaceTime prototype: echo packets, Daily's 4 KB cap, playback ledger
  // -----------------------------------------------------------------------

  const conversationId = "c" + "a".repeat(35);
  const pcm20 = new Uint8Array(pcm16BytesFor(ECHO_CHUNK_MS));
  const packet20 = echoAudioMessage({
    conversationId,
    pcm: pcm20,
    inferenceId: "inf-20",
    done: false,
  });
  check(
    "54 a 20 ms 16 kHz echo envelope fits Daily's 4 KB cap",
    packet20.bytes <= DAILY_APP_MESSAGE_LIMIT_BYTES &&
      packet20.message.properties.modality === "audio",
    packet20.bytes
  );
  check(
    "55 the 20 ms envelope is well under the cap, not merely equal",
    packet20.bytes < 2048,
    packet20.bytes
  );

  const packet40 = echoAudioMessage({
    conversationId,
    pcm: new Uint8Array(pcm16BytesFor(40)),
    inferenceId: "inf-40",
    done: false,
  });
  check(
    "56 a 40 ms 16 kHz envelope still fits",
    fitsDailyAppMessage(packet40.bytes),
    packet40.bytes
  );

  const packet200at24k = echoAudioMessage({
    conversationId,
    pcm: new Uint8Array(pcm16BytesFor(200, 24_000)),
    sampleRate: 24_000,
    inferenceId: "inf-200",
    done: false,
  });
  check(
    "57 200 ms at 24 kHz does not fit, so we must not send it",
    !fitsDailyAppMessage(packet200at24k.bytes),
    packet200at24k.bytes
  );

  const interrupt = interruptMessage(conversationId);
  check(
    "58 interrupt is a conversation.interrupt with no audio payload",
    interrupt.message.event_type === "conversation.interrupt" &&
      !("properties" in interrupt.message)
  );

  const down = resampleFloat32(new Float32Array([0, 0.5, 1, 0.5]), 48_000, 16_000);
  check("59 48 kHz audio resamples to a shorter 16 kHz buffer", down.length === 1 || down.length === 2, down.length);

  const pcm = floatToPcm16(new Float32Array([0, 1, -1]));
  check(
    "60 PCM16 is little-endian signed 16-bit, two bytes per sample",
    pcm.length === 6 && pcm[2] === 0xff && pcm[3] === 0x7f
  );

  const ledger = new PlaybackLedger();
  ledger.beginUtterance("inf-a");
  const chunk = new Uint8Array(pcm16BytesFor(ECHO_CHUNK_MS, ECHO_SAMPLE_RATE));
  ledger.recordGenerated(chunk);
  const taken = ledger.takeChunk(chunk.length);
  check("61 generated audio is queued until a full echo chunk exists", taken?.length === chunk.length);
  ledger.recordHanded(taken!, packet20.bytes);
  check("62 handed is not treated as played", ledger.queueMs() === ECHO_CHUNK_MS);

  ledger.recordPlayed(0.2, 1_000);
  ledger.recordPlayed(0.2, 1_010);
  check("63 played energy accumulates wall-clock, not OpenAI status", ledger.playedMs === 10);

  const barge = ledger.interrupt(1_050);
  check(
    "64 barge-in drops the unsent queue and keeps the previous inference id",
    barge.previousInferenceId === "inf-a" && ledger.flushPending().length === 0
  );
  check(
    "66 a barged-in turn is persisted as interrupted, not delivered",
    (() => {
      const verdict = ledger.persistence();
      return verdict.interrupted && verdict.reason === "barge_in";
    })()
  );
  ledger.beginUtterance("inf-b");
  check("65 the next answer gets a new inference id", ledger.inferenceId === "inf-b");

  const drained = new PlaybackLedger();
  drained.beginUtterance("inf-c");
  drained.recordGenerated(chunk);
  drained.recordHanded(chunk, packet20.bytes);
  drained.recordPlayed(0.2, 2_000);
  drained.recordPlayed(0.2, 2_000 + ECHO_CHUNK_MS);
  check(
    "67 only a drained, un-interrupted turn can be treated as heard",
    drained.persistence().interrupted === false
  );

  const uncertain = new PlaybackLedger();
  uncertain.beginUtterance("inf-d");
  uncertain.recordGenerated(chunk);
  uncertain.recordHanded(chunk, packet20.bytes);
  const uncertainVerdict = uncertain.persistence();
  check(
    "68 without observed playback the turn is uncertain, so memory must not learn",
    uncertainVerdict.interrupted === true &&
      uncertainVerdict.reason === "playback_uncertain"
  );

  const leftover = new PlaybackLedger();
  leftover.beginUtterance("inf-e");
  leftover.recordGenerated(chunk);
  leftover.interrupt();
  check(
    "69 leftover generated audio after barge-in is dropped, not a new utterance",
    leftover.acceptGenerated(0.5) === false && leftover.inferenceId === null
  );
  check(
    "70 a quiet gap then energy is accepted as the next answer",
    leftover.acceptGenerated(0) === false && leftover.acceptGenerated(0.5) === true
  );

  const queued = new PlaybackLedger();
  queued.beginUtterance("inf-f");
  for (let i = 0; i < 50; i += 1) {
    queued.recordGenerated(chunk);
    queued.recordHanded(chunk, packet20.bytes);
  }
  check(
    "71 handing faster than playback grows the queue; sendAppMessage is not consumption",
    queued.queueMs() === 50 * ECHO_CHUNK_MS && queued.maxQueueMs === 50 * ECHO_CHUNK_MS
  );
}

try {
  await main();
} catch (error) {
  failed += 1;
  console.error("ERROR", error);
} finally {
  for (const workspace of workspaces) {
    await workspace.remove().catch(() => undefined);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
