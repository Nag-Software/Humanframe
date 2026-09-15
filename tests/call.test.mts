import { randomUUID } from "node:crypto";

import {
  createCallSession,
  endCallSession,
  loadCallBinding,
  type CallBinding,
} from "../server/call/binding.ts";
import { CALL_TOOLS, executeCallTool, isCallTool } from "../server/call/tools.ts";
import { recordCallTurn, previousUserTurn } from "../server/call/transcript.ts";
import {
  turnFromEvent,
  toolCallFromEvent,
  realtimeSessionConfig,
} from "../server/call/openai-realtime.ts";
import { admin, createTestWorkspace, type TestWorkspace } from "./memory-support.mts";

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
  // Tool execution: scope comes from the binding, never from arguments
  // -----------------------------------------------------------------------

  check("20 only the three phase 5 tools exist", CALL_TOOLS.length === 3);
  check("21 unknown tools are refused", !isCallTool("draft_email"));

  const refused = await executeCallTool(call, "draft_email", {}, "call_x");
  check("22 an unlisted tool returns an error, not an action", refused.ok === false);

  const due = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
  const scheduled = await executeCallTool(
    call,
    "schedule_followup",
    {
      title: "Ringe Anders",
      dueAt: due,
      kind: "remind",
      // A hostile model trying to widen its own scope. These are ignored:
      // there is no code path that reads scope from arguments.
      workspaceId: mallory.workspaceId,
      userId: mallory.userId,
      threadId: randomUUID(),
    },
    "call_schedule_1"
  );
  check("23 a spoken reminder becomes a commitment", scheduled.ok === true);

  const commitmentId = (scheduled.output as { commitmentId?: string }).commitmentId;
  const { data: commitment } = await admin
    .from("commitments")
    .select("workspace_id, thread_id, user_id, dedupe_key, status")
    .eq("id", commitmentId ?? "")
    .single<{
      workspace_id: string;
      thread_id: string;
      user_id: string;
      dedupe_key: string;
      status: string;
    }>();

  check(
    "24 tool arguments cannot move a commitment to another workspace",
    commitment?.workspace_id === alice.workspaceId
  );
  check("25 it is owned by the caller, not by an argument", commitment?.user_id === alice.userId);
  check(
    "26 it is delivered back to the call's own thread",
    commitment?.thread_id === thread
  );
  check("27 it is scheduled, so the durable path owns it", commitment?.status === "scheduled");

  const again = await executeCallTool(
    call,
    "schedule_followup",
    { title: "Ringe Anders", dueAt: due, kind: "remind" },
    "call_schedule_1"
  );
  check(
    "28 a retried tool call claims the same commitment",
    (again.output as { commitmentId?: string }).commitmentId === commitmentId
  );

  const { count: commitmentCount } = await admin
    .from("commitments")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", alice.workspaceId);
  check("29 no second promise was made", commitmentCount === 1, commitmentCount);

  const listed = await executeCallTool(call, "list_commitments", {}, "call_list_1");
  const listedIds = (listed.output as { commitments: { id: string }[] }).commitments.map(
    (row) => row.id
  );
  check("30 list_commitments sees the new commitment", listedIds.includes(commitmentId!));

  // The same tool, run for a call in another tenant, must see nothing of ours.
  const mThread = await makeThread(mallory);
  const mCall = await makeCall(mallory, mThread);
  const mList = await executeCallTool(mCall, "list_commitments", {}, "call_list_2");
  check(
    "31 another tenant's call sees none of it",
    (mList.output as { commitments: unknown[] }).commitments.length === 0
  );

  const badDate = await executeCallTool(
    call,
    "schedule_followup",
    { title: "Noe", dueAt: "på fredag", kind: "remind" },
    "call_schedule_bad"
  );
  check("32 a spoken date that never resolved is refused", badDate.ok === false);

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

  const tavusTool = await executeCallTool(
    tavusBinding,
    "list_commitments",
    {},
    "tavus-call-1"
  );
  check("39 the shared executor runs for another provider", tavusTool.ok === true);

  // -----------------------------------------------------------------------
  // The OpenAI adapter, in isolation
  // -----------------------------------------------------------------------

  check(
    "40 a partial transcript is not a turn",
    turnFromEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      transcript: "halv",
    }) === null
  );

  const userTurn = turnFromEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item_1",
    transcript: "  hele setningen  ",
  });
  check(
    "41 a completed transcription is a user turn",
    userTurn?.role === "user" && userTurn.text === "hele setningen"
  );

  const cutTurn = turnFromEvent({
    type: "conversation.item.done",
    item: {
      id: "item_2",
      role: "assistant",
      status: "incomplete",
      content: [{ type: "output_audio", transcript: "Jeg kan også" }],
    },
  });
  check("42 an incomplete item is an interrupted turn", cutTurn?.interrupted === true);

  const doneTurn = turnFromEvent({
    type: "conversation.item.done",
    item: {
      id: "item_3",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_audio", transcript: "Ferdig." }],
    },
  });
  check("43 a completed item is not interrupted", doneTurn?.interrupted === false);

  check(
    "44 a partial argument stream is not a tool call",
    toolCallFromEvent({
      type: "response.function_call_arguments.delta",
      name: "schedule_followup",
      call_id: "call_1",
      arguments: '{"tit',
    }) === null
  );

  const parsedCall = toolCallFromEvent({
    type: "response.function_call_arguments.done",
    name: "recall",
    call_id: "call_1",
    arguments: '{"query":"Anders"}',
  });
  check(
    "45 a finished argument stream is a tool call",
    parsedCall?.name === "recall" &&
      (parsedCall.args as { query: string }).query === "Anders"
  );

  const config = realtimeSessionConfig({
    instructions: "You are Maya.",
    tools: CALL_TOOLS,
  }) as {
    tools: { name: string }[];
    instructions: string;
    audio: { input: { turn_detection: { interrupt_response: boolean } } };
  };
  check(
    "46 the session offers exactly the shared tools",
    config.tools.map((tool) => tool.name).join(",") ===
      CALL_TOOLS.map((tool) => tool.name).join(",")
  );
  check(
    "47 interruption is enabled at the provider",
    config.audio.input.turn_detection.interrupt_response === true
  );
  check(
    "48 no credential is in the session configuration",
    !JSON.stringify(config).includes("sk-")
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
