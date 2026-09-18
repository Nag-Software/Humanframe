// First: it loads .env.local before anything parses the environment.
import { admin, createTestWorkspace, type TestWorkspace } from "./memory-support.mts";
import {
  decideCallStart,
  overageUsdFor,
  periodBounds,
  summarizeUsage,
  DEFAULT_USAGE_SETTINGS,
} from "../lib/plans.ts";
import { loadUsageSettings } from "../lib/settings/usage-settings.ts";
import { loadUsageSummary } from "../server/billing/usage.ts";
import { checkCallLimits } from "../server/call/limits.ts";

/**
 * Plans, included minutes and overage.
 *
 * The arithmetic is pure and tested as such; the ledger, the row level
 * security on the overage decision and the start-of-call verdict run against
 * the real database, because tenancy and the composite keys are what is
 * under test.
 *
 *   pnpm test:usage
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

const NOW = new Date("2026-09-18T10:00:00Z");

function arithmetic(): void {
  const { start, end } = periodBounds(NOW);
  check("1 the period is the calendar month", start.toISOString() === "2026-09-01T00:00:00.000Z" && end.toISOString() === "2026-10-01T00:00:00.000Z");
  check("2 overage bills per started minute", overageUsdFor("voice", 61) === 0.3 && overageUsdFor("video", 1) === 0.89);
  check("3 no overage costs nothing", overageUsdFor("voice", 0) === 0);

  const inside = summarizeUsage({ plan: "starter", now: NOW, usedSeconds: { voice: 60 * 100, video: 60 * 10 } });
  check("4 inside the plan there is no overage", inside.overageUsd === 0 && inside.voice.overageSeconds === 0);

  const over = summarizeUsage({ plan: "starter", now: NOW, usedSeconds: { voice: 60 * 200, video: 60 * 45 } });
  check("5 beyond the plan is counted in money", over.voice.overageUsd === 3 && over.video.overageUsd === 13.35 && over.overageUsd === 16.35, over);

  const pro = summarizeUsage({ plan: "pro", now: NOW, usedSeconds: { voice: 60 * 200, video: 60 * 45 } });
  check("6 pro includes three times the minutes", pro.overageUsd === 0 && pro.voice.includedSeconds === 540 * 60);
}

function decisions(): void {
  const max = 15 * 60;
  const fresh = summarizeUsage({ plan: "starter", now: NOW, usedSeconds: { voice: 0, video: 0 } });
  const nearly = summarizeUsage({ plan: "starter", now: NOW, usedSeconds: { voice: 180 * 60 - 120, video: 0 } });
  const spent = summarizeUsage({ plan: "starter", now: NOW, usedSeconds: { voice: 180 * 60, video: 30 * 60 } });
  const capped = summarizeUsage({ plan: "starter", now: NOW, usedSeconds: { voice: 180 * 60 + 60 * 40, video: 30 * 60 } });

  const a = decideCallStart({ kind: "voice", usage: fresh, settings: DEFAULT_USAGE_SETTINGS, maxCallSeconds: max });
  check("7 a fresh plan allows a full-length call", a.allowed && a.allowedSeconds === max && !a.beyondPlan, a);

  const b = decideCallStart({ kind: "voice", usage: nearly, settings: DEFAULT_USAGE_SETTINGS, maxCallSeconds: max });
  check("8 the last two minutes end the call when they run out", b.allowed && b.allowedSeconds === 120, b);

  const c = decideCallStart({ kind: "voice", usage: nearly, settings: { allowOverage: true, overageCapUsd: null }, maxCallSeconds: max });
  check("9 with overage on, the call may run past the plan", c.allowed && c.allowedSeconds === max, c);

  const d = decideCallStart({ kind: "voice", usage: spent, settings: DEFAULT_USAGE_SETTINGS, maxCallSeconds: max });
  check("10 a spent plan refuses without overage", !d.allowed && d.reason === "plan_exhausted", d);

  const e = decideCallStart({ kind: "video", usage: spent, settings: { allowOverage: true, overageCapUsd: null }, maxCallSeconds: max });
  check("11 a spent plan allows a call beyond it when overage is on", e.allowed && e.beyondPlan && e.allowedSeconds === max, e);

  const f = decideCallStart({ kind: "voice", usage: spent, settings: { allowOverage: true, overageCapUsd: 1 }, maxCallSeconds: max });
  check("12 a cap bounds the call to what it still pays for", f.allowed && f.allowedSeconds === 400, f);

  const g = decideCallStart({ kind: "voice", usage: capped, settings: { allowOverage: true, overageCapUsd: 6 }, maxCallSeconds: max });
  check("13 a cap that is spent refuses", !g.allowed && g.reason === "overage_cap", g);

  const h = decideCallStart({ kind: "video", usage: capped, settings: { allowOverage: true, overageCapUsd: 6.5 }, maxCallSeconds: max });
  check("14 less than a minute left under the cap refuses", !h.allowed && h.reason === "overage_cap", h);
}

async function createThread(workspace: TestWorkspace): Promise<string> {
  const { data } = await admin
    .from("threads")
    .insert({ workspace_id: workspace.workspaceId, assistant_id: workspace.assistantId, title: "usage" })
    .select("id")
    .single<{ id: string }>();
  return data!.id;
}

async function insertCall(
  workspace: TestWorkspace,
  threadId: string,
  input: { kind: "voice" | "video"; minutes: number; status?: "ended" | "failed" | "active"; daysAgo?: number }
): Promise<void> {
  const started = new Date(Date.now() - (input.daysAgo ?? 0) * 86400_000 - input.minutes * 60_000);
  const { error } = await admin.from("call_sessions").insert({
    workspace_id: workspace.workspaceId,
    assistant_id: workspace.assistantId,
    thread_id: threadId,
    user_id: workspace.userId,
    provider: "openai_realtime",
    kind: input.kind,
    status: input.status ?? "ended",
    started_at: started.toISOString(),
    ended_at: input.status === "active" ? null : new Date(started.getTime() + input.minutes * 60_000).toISOString(),
  });
  if (error) throw new Error(error.message);
}

async function ledger(workspace: TestWorkspace, other: TestWorkspace): Promise<void> {
  const threadId = await createThread(workspace);
  await insertCall(workspace, threadId, { kind: "voice", minutes: 20 });
  await insertCall(workspace, threadId, { kind: "voice", minutes: 5, status: "failed" });
  await insertCall(workspace, threadId, { kind: "video", minutes: 8 });
  await insertCall(workspace, threadId, { kind: "voice", minutes: 3, status: "active" });

  const usage = await loadUsageSummary(workspace.userClient, { workspaceId: workspace.workspaceId, plan: "starter" });
  check("15 the ledger counts ended and live calls, not failed ones", Math.round(usage.voice.usedSeconds / 60) === 23 && Math.round(usage.video.usedSeconds / 60) === 8, usage);

  const foreign = await loadUsageSummary(other.userClient, { workspaceId: workspace.workspaceId, plan: "starter" });
  check("16 another workspace sees nothing of this ledger", foreign.voice.usedSeconds === 0 && foreign.video.usedSeconds === 0);

  const { data: ws } = await admin.from("workspaces").select("plan").eq("id", workspace.workspaceId).single<{ plan: string }>();
  check("17 a new workspace starts on Starter", ws?.plan === "starter", ws);
}

async function overageSettings(workspace: TestWorkspace, other: TestWorkspace): Promise<void> {
  const before = await loadUsageSettings(workspace.userClient, workspace.workspaceId);
  check("18 the default is to stop at the plan", before.allowOverage === false && before.overageCapUsd === null);

  const { error: ownerWrite } = await workspace.userClient
    .from("usage_settings")
    .upsert({ workspace_id: workspace.workspaceId, allow_overage: true, overage_cap_cents: 2500, updated_by: workspace.userId }, { onConflict: "workspace_id" });
  const after = await loadUsageSettings(workspace.userClient, workspace.workspaceId);
  check("19 the owner can allow overage with a cap", !ownerWrite && after.allowOverage && after.overageCapUsd === 25, { ownerWrite, after });

  const { error: foreignWrite, data: foreignRows } = await other.userClient
    .from("usage_settings")
    .update({ allow_overage: false })
    .eq("workspace_id", workspace.workspaceId)
    .select("workspace_id");
  const still = await loadUsageSettings(workspace.userClient, workspace.workspaceId);
  check("20 another workspace cannot change it", (foreignRows?.length ?? 0) === 0 && still.allowOverage === true, { foreignWrite, foreignRows });

  const foreignRead = await loadUsageSettings(other.userClient, workspace.workspaceId);
  check("21 …or read it", foreignRead.allowOverage === false && foreignRead.overageCapUsd === null);
}

async function verdicts(workspace: TestWorkspace): Promise<void> {
  const threadId = await createThread(workspace);
  // 23 voice minutes exist from the ledger test; push voice past 180 and video past 30.
  await insertCall(workspace, threadId, { kind: "voice", minutes: 160 });
  await insertCall(workspace, threadId, { kind: "video", minutes: 25 });
  // Any call still open would trip the concurrency cap before the plan is consulted.
  await admin.from("call_sessions").update({ status: "ended", ended_at: new Date().toISOString() }).eq("workspace_id", workspace.workspaceId).eq("status", "active");

  const stop = await checkCallLimits({ workspaceId: workspace.workspaceId, userId: workspace.userId, kind: "voice", plan: "starter", settings: { allowOverage: false, overageCapUsd: null } });
  check("22 a spent plan refuses a call", !stop.allowed && stop.reason === "plan_exhausted", stop);

  const go = await checkCallLimits({ workspaceId: workspace.workspaceId, userId: workspace.userId, kind: "voice", plan: "starter", settings: { allowOverage: true, overageCapUsd: null } });
  check("23 …unless overage is allowed", go.allowed && go.beyondPlan, go);

  const capped = await checkCallLimits({ workspaceId: workspace.workspaceId, userId: workspace.userId, kind: "video", plan: "starter", settings: { allowOverage: true, overageCapUsd: 5 } });
  check("24 the cap becomes the call's ceiling", capped.allowed && capped.allowedSeconds > 0 && capped.allowedSeconds < 6 * 60, capped);

  const pro = await checkCallLimits({ workspaceId: workspace.workspaceId, userId: workspace.userId, kind: "voice", plan: "pro", settings: { allowOverage: false, overageCapUsd: null } });
  check("25 the same usage is inside Pro", pro.allowed && !pro.beyondPlan, pro);
}

async function main(): Promise<void> {
  arithmetic();
  decisions();

  const workspace = await createTestWorkspace("usage-a");
  const other = await createTestWorkspace("usage-b");
  try {
    await ledger(workspace, other);
    await overageSettings(workspace, other);
    await verdicts(workspace);
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
