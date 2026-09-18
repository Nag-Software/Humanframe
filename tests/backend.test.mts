import { randomUUID } from "node:crypto";

import { buildCallEndedMessage, callDeservesTrace } from "../agent/lib/call-trace.ts";
import { createGoal, listGoals, setGoalStatus } from "../agent/lib/goals.ts";
import {
  buildOpeningMessage,
  hasSomethingToOpen,
  openingMarker,
} from "../agent/lib/opening.ts";
import { chooseTitle, titleThreadIfNeeded } from "../agent/lib/thread-title.ts";
import { firstText, isSignal, parseSignal, signalMarker } from "../lib/signals.ts";
import {
  correctFact,
  listRememberedFacts,
  retractFact,
} from "../server/db/repositories/memory.ts";
import { loadOpeningBrief } from "../server/db/repositories/opening.ts";
import { takeRateLimit } from "../server/rate-limit.ts";
import { admin, createTestWorkspace, type TestWorkspace } from "./memory-support.mts";

/**
 * The relationship backend: signals, opening the day, her own titles, the
 * call trace, memory the user can correct, goals, and rate limits.
 *
 * No model calls and no HTTP. The database is real, because tenancy, the
 * unique indexes and the security-definer limiter are the things under test.
 *
 *   pnpm test:backend
 */

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

async function createThread(
  workspace: TestWorkspace,
  title: string,
  lastMessageAt = new Date()
): Promise<string> {
  const { data, error } = await admin
    .from("threads")
    .insert({
      workspace_id: workspace.workspaceId,
      assistant_id: workspace.assistantId,
      title,
      last_message_at: lastMessageAt.toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) {
    throw new Error(`thread insert failed: ${error?.message}`);
  }
  return data.id;
}

function signals(): void {
  const marker = signalMarker("open-day", "2026-09-18");
  check("1 a marker has the shared shape", marker === "[humanframe:open-day:2026-09-18]", marker);
  check("2 a delivery marker keeps the wake prefix", signalMarker("delivery", "abc").startsWith("[humanframe:delivery:"));
  check("3 a signal is recognised with leading whitespace", isSignal("  [humanframe:call-ended:x]\nThe call…"));
  check("4 ordinary text is not a signal", !isSignal("Can you check [humanframe] for me?"));
  check("5 a marker without an id is not a signal", !isSignal("[humanframe:open-day:]"));
  check("6 a signal parses", JSON.stringify(parseSignal(`${marker} hi`)) === JSON.stringify({ kind: "open-day", id: "2026-09-18" }));
  check("7 firstText reads a parts array", firstText([{ type: "file" }, { type: "text", text: "x" }]) === "x");
  check("8 firstText reads a string", firstText("plain") === "plain");
  check("9 firstText is null for nothing", firstText(42) === null);
}

function opening(): void {
  const now = new Date("2026-09-18T07:30:00Z");
  const brief = {
    commitments: [
      { title: "Come back on the Nordvik offer", kind: "follow_up" as const, dueAt: "2026-09-17T08:00:00Z", status: "scheduled" },
      { title: "Draft the job posts", kind: "deliver" as const, dueAt: "2026-09-19T08:00:00Z", status: "scheduled" },
    ],
    recentThreads: [{ title: "Three offers", lastMessageAt: "2026-09-17T15:00:00Z" }],
    timezone: "Europe/Oslo",
  };
  const message = buildOpeningMessage(brief, now);

  check("10 the opening leads with today's marker", message.startsWith("[humanframe:open-day:2026-09-18]"));
  check("11 an overdue promise is marked as such", message.includes("OVERDUE") && message.includes("Nordvik"));
  // `en-GB` spells the month "Sept" on some ICU builds and "Sep" on others.
  check("12 a future promise says when", /Due Sat 19 Sept?: Draft the job posts \(deliver\)/.test(message), message);
  check("13 recent conversations are listed", message.includes("Three offers"));
  check("14 the marker is stable within a day", openingMarker(now, "Europe/Oslo") === openingMarker(new Date("2026-09-18T20:00:00Z"), "Europe/Oslo"));
  check("15 the marker follows the user's zone", openingMarker(new Date("2026-09-18T23:30:00Z"), "Europe/Oslo") === "[humanframe:open-day:2026-09-19]");
  check("16 an empty brief opens nothing", !hasSomethingToOpen({ commitments: [], recentThreads: [], timezone: null }));
  check("17 one thread is enough to open", hasSomethingToOpen({ commitments: [], recentThreads: brief.recentThreads, timezone: null }));
}

function trace(): void {
  check("18 a short call leaves no trace", !callDeservesTrace({ durationMs: 8_000, turnCount: 6 }));
  check("19 a one-turn call leaves no trace", !callDeservesTrace({ durationMs: 60_000, turnCount: 1 }));
  check("20 a real call leaves a trace", callDeservesTrace({ durationMs: 60_000, turnCount: 2 }));
  const message = buildCallEndedMessage({ callSessionId: "abc", durationMs: 130_000, turnCount: 7, video: true });
  check("21 the trace signal names the call", message.startsWith("[humanframe:call-ended:abc]"));
  check("22 the trace signal says how long", message.includes("about 2 minutes (7 turns)") && message.includes("video call"), message);
}

function titles(): void {
  check("23 quotes and a period are stripped", chooseTitle('"Q4 hiring plan."') === "Q4 hiring plan");
  check("24 a Title: prefix is stripped", chooseTitle("Title: Offers from Nordvik") === "Offers from Nordvik");
  check("25 a long title is cut with an ellipsis", chooseTitle("a".repeat(80))!.length === 60);
  check("26 nothing usable is null", chooseTitle('""') === null);
}

async function threadTitles(workspace: TestWorkspace): Promise<void> {
  const threadId = await createThread(workspace, "hey can you look at the three offers I got");
  let calls = 0;

  const first = await titleThreadIfNeeded(admin, {
    threadId,
    userText: "hey can you look at the three offers",
    assistantText: "Nordvik is the only one with a fixed delivery date.",
    generate: async () => {
      calls += 1;
      return '"Three offers."';
    },
  });
  const { data: row } = await admin
    .from("threads")
    .select("title, title_source")
    .eq("id", threadId)
    .single<{ title: string; title_source: string }>();

  check("27 the first exchange names the thread", first === "Three offers" && row?.title === "Three offers", row);
  check("28 the thread records that she named it", row?.title_source === "assistant", row);

  const second = await titleThreadIfNeeded(admin, {
    threadId,
    userText: "and the payment terms?",
    assistantText: "Net 60.",
    generate: async () => {
      calls += 1;
      return "Payment terms";
    },
  });
  check("29 her title is never overwritten", second === null && calls === 1, { second, calls });

  const skipped = await titleThreadIfNeeded(admin, {
    threadId: await createThread(workspace, "raw"),
    userText: null,
    assistantText: "   ",
    generate: async () => "Should not run",
  });
  check("30 an empty reply names nothing", skipped === null);
}

/** Runs on a fresh workspace, so what is "recent" is only what this creates. */
async function openingBrief(workspace: TestWorkspace): Promise<void> {
  await createThread(workspace, "Ten days ago", new Date(Date.now() - 10 * 24 * 3600_000));
  const quiet = await loadOpeningBrief(workspace.userClient, {
    workspaceId: workspace.workspaceId,
    assistantId: workspace.assistantId,
    userId: workspace.userId,
  });
  check("31 an old thread does not open the day", !hasSomethingToOpen(quiet), quiet);

  const threadId = await createThread(workspace, "Board deck");
  await admin.from("commitments").insert({
    workspace_id: workspace.workspaceId,
    assistant_id: workspace.assistantId,
    thread_id: threadId,
    title: "Remind you about the board deck",
    kind: "remind",
    due_at: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
    due_timezone: "UTC",
    dedupe_key: `test:${randomUUID()}`,
  });

  const live = await loadOpeningBrief(workspace.userClient, {
    workspaceId: workspace.workspaceId,
    assistantId: workspace.assistantId,
    userId: workspace.userId,
  });
  check("32 a due promise opens the day", hasSomethingToOpen(live) && live.commitments.some((c) => c.title.includes("board deck")), live);
  check("33 the brief carries recent titles", live.recentThreads.some((t) => t.title === "Board deck"));
  check("34 the brief is read as the user", live.commitments.every((c) => typeof c.dueAt === "string"));
}

async function memory(workspace: TestWorkspace, other: TestWorkspace): Promise<void> {
  const { data: fact } = await admin
    .from("facts")
    .insert({
      workspace_id: workspace.workspaceId,
      assistant_id: workspace.assistantId,
      kind: "fact",
      attribute: "company size",
      value: "three engineers",
    })
    .select("id")
    .single<{ id: string }>();
  if (!fact) throw new Error("fact insert failed");

  const corrected = await correctFact(workspace.userClient, workspace.workspaceId, fact.id, "two engineers");
  const { data: old } = await admin
    .from("facts")
    .select("status, superseded_by")
    .eq("id", fact.id)
    .single<{ status: string; superseded_by: string | null }>();

  check("35 a correction creates the new statement", corrected?.value === "two engineers" && corrected.id !== fact.id, corrected);
  check("36 the old statement is superseded and points forward", old?.status === "superseded" && old.superseded_by === corrected?.id, old);

  const visible = await listRememberedFacts(workspace.userClient, workspace.workspaceId, workspace.assistantId);
  check("37 her profile shows only the corrected statement", visible.length === 1 && visible[0]?.value === "two engineers", visible);

  const same = await correctFact(workspace.userClient, workspace.workspaceId, corrected!.id, "  two engineers ");
  check("38 correcting to the same value changes nothing", same?.id === corrected?.id);

  const foreign = await retractFact(other.userClient, other.workspaceId, corrected!.id);
  const { data: untouched } = await admin.from("facts").select("status").eq("id", corrected!.id).single<{ status: string }>();
  check("39 another workspace cannot take a fact away", foreign === false && untouched?.status === "active");

  const removed = await retractFact(workspace.userClient, workspace.workspaceId, corrected!.id);
  const { data: gone } = await admin.from("facts").select("status, valid_to").eq("id", corrected!.id).single<{ status: string; valid_to: string | null }>();
  check("40 the user can take a fact away", removed && gone?.status === "retracted" && gone.valid_to !== null, gone);
  check("41 a retracted fact leaves the profile", (await listRememberedFacts(workspace.userClient, workspace.workspaceId, workspace.assistantId)).length === 0);
  check("42 retracting twice is a no-op", (await retractFact(workspace.userClient, workspace.workspaceId, corrected!.id)) === false);
}

async function goals(workspace: TestWorkspace, other: TestWorkspace): Promise<void> {
  const scope = { client: admin, workspaceId: workspace.workspaceId, assistantId: workspace.assistantId };
  const key = `call:${randomUUID()}`;
  const first = await createGoal(scope, { title: "Hire two engineers", priority: "high", dedupeKey: key, userId: workspace.userId });
  const again = await createGoal(scope, { title: "Hire two engineers", priority: "high", dedupeKey: key, userId: workspace.userId });
  check("43 a replayed goal claims the same row", first.id === again.id);

  await createGoal(scope, { title: "Close Nordvik", dedupeKey: `call:${randomUUID()}` });
  const open = await listGoals(scope);
  check("44 goals list highest priority first", open.length === 2 && open[0]?.title === "Hire two engineers", open.map((g) => g.title));

  const achieved = await setGoalStatus(scope, first.id, "achieved");
  check("45 a goal can be achieved", achieved?.status === "achieved");
  check("46 an achieved goal leaves the open list", (await listGoals(scope)).length === 1);
  check("47 …and stays in the full list", (await listGoals(scope, { includeClosed: true })).length === 2);

  const foreign = await setGoalStatus(
    { client: other.userClient, workspaceId: other.workspaceId, assistantId: other.assistantId },
    first.id,
    "dropped"
  );
  check("48 another workspace cannot touch a goal", foreign === null);
}

async function rateLimits(workspace: TestWorkspace): Promise<void> {
  const rule = { bucket: `test:${randomUUID()}`, limit: 3, windowSeconds: 60 };
  const results: boolean[] = [];
  for (let i = 0; i < 4; i += 1) {
    results.push(await takeRateLimit(workspace.userClient, rule));
  }
  check("49 the limit allows exactly the budget", JSON.stringify(results) === "[true,true,true,false]", results);

  const elsewhere = await takeRateLimit(workspace.userClient, { ...rule, bucket: `${rule.bucket}:other` });
  check("50 buckets are independent", elsewhere === true);

  const anonymous = await takeRateLimit(admin, rule);
  check("51 no principal means no budget", anonymous === false);
}

async function main(): Promise<void> {
  signals();
  opening();
  trace();
  titles();

  const workspace = await createTestWorkspace("backend-a");
  const other = await createTestWorkspace("backend-b");
  try {
    await threadTitles(workspace);
    await openingBrief(other);
    await memory(workspace, other);
    await goals(workspace, other);
    await rateLimits(workspace);
  } finally {
    await workspace.remove();
    await other.remove();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

await main();
