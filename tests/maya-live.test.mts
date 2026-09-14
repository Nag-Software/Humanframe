/**
 * Live regression tests for what the Maya thread actually renders.
 *
 * They run against the local dev server with NEXT_PUBLIC_MAYA_RUNTIME=eve, go
 * through the app's own session route, and project the stream with eve's
 * reducer plus our assistant-ui adapter. A turn that only produces a tool call
 * fails here the same way it failed in the UI.
 *
 * They need a running dev server and model credits. The deterministic half of
 * the suite lives in maya-fixtures.test.mts and needs neither.
 *
 *   pnpm test:live
 */
import {
  BridgeSession,
  createTestUser,
  loadEnv,
  partsOf,
  toolCalls,
  visibleText,
  type ThreadPart,
} from "./harness.mts";

const env = loadEnv();
const APP_URL = env.APP_URL ?? "http://localhost:3000";
const ARTIFACT_TOOLS = new Set([
  "create_file",
  "draft_email",
  "preview_calendar_event",
  "show_website",
]);

type Case = {
  name: string;
  run: (session: BridgeSession) => Promise<void>;
};

type Status = "pass" | "fail" | "skip";

const results: { name: string; status: Status; detail?: string }[] = [];

/**
 * The AI Gateway rate-limits free-tier traffic per model. That says nothing
 * about Maya's behaviour, so it is reported as skipped rather than failed.
 * Every other error still fails the run.
 */
const RATE_LIMIT_PATTERN = /GatewayRateLimitError|rate-limited|rate limit/i;

function isExternalRateLimit(session: BridgeSession, error: unknown): boolean {
  const detail = `${session.lastFailure ?? ""} ${
    error instanceof Error ? error.message : String(error)
  }`;
  return RATE_LIMIT_PATTERN.test(detail);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/** A failed turn explains an empty projection better than the assertion does. */
function check(session: BridgeSession, condition: boolean, message: string) {
  assert(condition, session.lastFailure ? `${message} (turn failed — ${session.lastFailure})` : message);
}

const PAUSE_BETWEEN_CASES_MS = 20_000;

function hasArtifact(parts: ThreadPart[]): boolean {
  return parts.some(
    (part) => part.type === "tool-call" && ARTIFACT_TOOLS.has(part.toolName)
  );
}

const cases: Case[] = [
  {
    name: "1. a greeting is answered as plain text",
    async run(session) {
      await session.start("Hei");
      await session.settle();

      const parts = partsOf(session.lastAssistantMessage);
      check(session, visibleText(parts).length > 0, "no visible assistant text");
      assert(
        toolCalls(parts).length === 0,
        `expected no tool calls, saw ${toolCalls(parts)
          .map((call) => call.toolName)
          .join(", ")}`
      );
    },
  },
  {
    name: "2. a capability question is answered as plain text",
    async run(session) {
      await session.start("Hva kan du gjøre?");
      await session.settle();

      const parts = partsOf(session.lastAssistantMessage);
      check(session, visibleText(parts).length > 0, "no visible assistant text");
      assert(
        toolCalls(parts).length === 0,
        `expected no tool calls, saw ${toolCalls(parts)
          .map((call) => call.toolName)
          .join(", ")}`
      );
    },
  },
  {
    name: "3. a document request without content asks for the content in text",
    async run(session) {
      await session.start("Lag et møtereferat jeg kan laste ned");
      await session.settle();

      const parts = partsOf(session.lastAssistantMessage);
      const text = visibleText(parts);
      assert(text.length > 0, "no visible assistant text");
      assert(
        !toolCalls(parts).some((call) => call.toolName === "create_file"),
        "Maya produced a file instead of asking for the notes"
      );
      assert(text.includes("?"), `expected a question, got: ${text.slice(0, 120)}`);
    },
  },
  {
    name: "4. reading a page shows one approval card, then a summary",
    async run(session) {
      await session.start("Les example.com og oppsummer den for meg");
      await session.settle();

      const pending = session.pendingApprovals();
      check(
        session,
        pending.length === 1,
        `expected exactly one approval, saw ${pending.length}`
      );
      assert(
        pending[0].toolName === "web_fetch",
        `unexpected tool: ${pending[0].toolName}`
      );

      await session.respond(pending[0].requestId, "approve");
      await session.settle();

      const parts = partsOf(session.lastAssistantMessage);
      assert(
        session.pendingApprovals().length === 0,
        "approval still pending after approving"
      );
      assert(
        visibleText(parts).length > 0,
        "no visible summary after the tool ran"
      );
    },
  },
  {
    name: "5. a completed tool call always ends in something visible",
    async run(session) {
      // The content is supplied, so this is real work rather than a question.
      await session.start(
        "Lag en nedlastbar markdown-fil som heter agenda.md med punktene: " +
          "1) status, 2) risiko, 3) neste steg."
      );
      await session.settle();

      const parts = partsOf(session.lastAssistantMessage);
      const calls = toolCalls(parts);
      check(
        session,
        calls.length > 0,
        `expected a tool call, saw only text: ${visibleText(parts).slice(0, 120)}`
      );
      assert(
        visibleText(parts).length > 0 || hasArtifact(parts),
        "tool ran but the turn produced nothing the user can see"
      );
    },
  },
];

const user = await createTestUser(env);
console.log(`test user ${user.userId}\n`);

try {
  for (const [index, testCase] of cases.entries()) {
    if (index > 0) {
      // The gateway rate-limits free-tier traffic per model; pacing keeps the
      // suite measuring Maya's behaviour rather than the quota.
      await new Promise((resolve) =>
        setTimeout(resolve, PAUSE_BETWEEN_CASES_MS)
      );
    }
    const session = new BridgeSession(APP_URL, user.cookie);
    try {
      await testCase.run(session);
      results.push({ name: testCase.name, status: "pass" });
      console.log(`PASS     ${testCase.name}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      if (isExternalRateLimit(session, error)) {
        results.push({ name: testCase.name, status: "skip", detail });
        console.log(
          `SKIPPED  ${testCase.name}\n         external rate limit — not a functional failure`
        );
        continue;
      }

      results.push({ name: testCase.name, status: "fail", detail });
      console.log(`FAIL     ${testCase.name}\n         ${detail}`);
    }
  }
} finally {
  await user.remove();
}

const passed = results.filter((result) => result.status === "pass");
const skipped = results.filter((result) => result.status === "skip");
const failed = results.filter((result) => result.status === "fail");

console.log(
  `\n${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed` +
    (skipped.length > 0
      ? "\nSkips are external rate limits. Re-run when the model quota allows."
      : "")
);
process.exit(failed.length === 0 ? 0 : 1);
