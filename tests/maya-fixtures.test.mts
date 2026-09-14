/**
 * Deterministic projection tests. No dev server, no model, no credits.
 *
 * They replay recorded eve stream events through eve's own reducer and the
 * assistant-ui adapter the Maya thread renders with, so the rule "a completed
 * tool call always ends in something the user can see" is enforced on every
 * run — the live suite can be rate-limited, this one cannot.
 *
 *   pnpm test
 */
import { defaultMessageReducer } from "eve/client";
import type { EveMessageData } from "eve/client";

import { toThreadMessage } from "../lib/maya/eve-message-adapter.ts";
import { partsOf, toolCalls, visibleText, type ThreadPart } from "./harness.mts";

type StreamEvent = Parameters<
  ReturnType<typeof defaultMessageReducer>["reduce"]
>[1];

let sequence = 0;

function event(type: string, data: Record<string, unknown>): StreamEvent {
  sequence += 1;
  return {
    type,
    data: { sequence: 0, stepIndex: 0, turnId: "turn_0", ...data },
    meta: {
      id: `evt_fixture_${sequence}`,
      at: new Date(1_800_000_000_000 + sequence * 1000).toISOString(),
    },
  } as unknown as StreamEvent;
}

function project(events: StreamEvent[]) {
  const reducer = defaultMessageReducer();
  let data: EveMessageData = reducer.initial();
  for (const streamEvent of events) {
    data = reducer.reduce(data, streamEvent);
  }
  return data.messages.map(toThreadMessage);
}

const ARTIFACT_TOOLS = new Set([
  "create_file",
  "draft_email",
  "preview_calendar_event",
  "show_website",
]);

function hasVisibleOutcome(parts: ThreadPart[]): boolean {
  return (
    visibleText(parts).length > 0 ||
    parts.some(
      (part) => part.type === "tool-call" && ARTIFACT_TOOLS.has(part.toolName)
    )
  );
}

const toolCallEvents = (toolName: string, output: unknown) => [
  event("session.started", { runtime: { agentId: "humanframe" } }),
  event("turn.started", {}),
  event("message.received", {
    message: "Lag en agenda",
    parts: [{ type: "text", text: "Lag en agenda" }],
  }),
  event("actions.requested", {
    actions: [
      {
        callId: "call_fixture",
        input: { filename: "agenda.md" },
        kind: "tool-call",
        toolName,
      },
    ],
  }),
  event("action.result", {
    result: { callId: "call_fixture", kind: "tool-result", output, toolName },
    status: "completed",
  }),
];

const cases: { name: string; run: () => void }[] = [
  {
    name: "a completed tool call followed by text ends visibly",
    run() {
      const messages = project([
        ...toolCallEvents("create_file", { filename: "agenda.md" }),
        event("message.completed", {
          finishReason: "stop",
          message: "Her er agendaen din.",
        }),
        event("turn.completed", {}),
      ]);

      const parts = partsOf(messages.at(-1));
      assert(toolCalls(parts).length === 1, "expected the tool call to render");
      assert(hasVisibleOutcome(parts), "turn produced nothing visible");
      assert(
        visibleText(parts) === "Her er agendaen din.",
        "the final text is missing from the projection"
      );
    },
  },
  {
    name: "an artifact tool alone counts as visible",
    run() {
      const messages = project([
        ...toolCallEvents("preview_calendar_event", { title: "Standup" }),
        event("turn.completed", {}),
      ]);

      assert(hasVisibleOutcome(partsOf(messages.at(-1))), "artifact not visible");
    },
  },
  {
    name: "a bare non-artifact tool call is not a visible outcome",
    run() {
      // The regression that started this: a turn whose only output was a tool
      // call rendered as "used a tool" and nothing else.
      const messages = project([
        ...toolCallEvents("web_search", { results: [] }),
        event("turn.completed", {}),
      ]);

      assert(
        !hasVisibleOutcome(partsOf(messages.at(-1))),
        "a bare tool call must not count as a visible answer"
      );
    },
  },
  {
    name: "an approval request projects as a pending approval, not as text",
    run() {
      const messages = project([
        event("session.started", { runtime: { agentId: "humanframe" } }),
        event("turn.started", {}),
        event("message.received", {
          message: "Les example.com",
          parts: [{ type: "text", text: "Les example.com" }],
        }),
        event("actions.requested", {
          actions: [
            {
              callId: "call_fetch",
              input: { url: "https://example.com" },
              kind: "tool-call",
              toolName: "web_fetch",
            },
          ],
        }),
        event("input.requested", {
          requests: [
            {
              action: {
                callId: "call_fetch",
                input: { url: "https://example.com" },
                kind: "tool-call",
                toolName: "web_fetch",
              },
              display: "confirmation",
              kind: "tool-approval",
              options: [
                { id: "approve", label: "Approve" },
                { id: "cancel", label: "Cancel", style: "danger" },
              ],
              prompt: "Approve tool call: web_fetch",
              requestId: "req_fixture",
            },
          ],
        }),
      ]);

      const parts = partsOf(messages.at(-1));
      const approvals = parts.filter(
        (part) => part.type === "tool-call" && part.approval
      );
      assert(approvals.length === 1, `expected one approval, saw ${approvals.length}`);

      const [approval] = approvals;
      assert(
        approval.type === "tool-call" &&
          approval.approval?.approved === undefined,
        "the approval should still be pending"
      );
      assert(
        approval.type === "tool-call" &&
          (approval.approval?.options ?? []).some(
            (option) => option.kind === "reject-once"
          ),
        "cancel should map to a reject option"
      );
    },
  },
];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

let failures = 0;
for (const testCase of cases) {
  try {
    testCase.run();
    console.log(`PASS  ${testCase.name}`);
  } catch (error) {
    failures += 1;
    console.log(
      `FAIL  ${testCase.name}\n      ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures === 0 ? 0 : 1);
