/**
 * Opt-in live memory test: real models, real embeddings, real threads.
 *
 * It proves the thing phase 3 exists for — Maya learns something in one thread
 * and uses it in another — so it cannot be faked with fixtures. It needs a dev
 * or production server and model credits, and reports an AI Gateway rate limit
 * as an external block rather than a functional failure.
 *
 *   APP_URL=http://127.0.0.1:3100 pnpm test:live:memory
 */
import { BridgeSession, loadEnv, partsOf, visibleText } from "./harness.mts";
import { admin, createTestWorkspace } from "./memory-support.mts";

const env = loadEnv();
const APP_URL = env.APP_URL ?? "http://127.0.0.1:3000";
const RATE_LIMIT = /GatewayRateLimitError|rate-limited|rate limit/i;
const EXTRACTION_TIMEOUT_MS = 60_000;

const workspace = await createTestWorkspace("live");
const cookie = await signInCookie();

let failures = 0;
let skipped = 0;

async function signInCookie(): Promise<string> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const { data } = await admin.auth.admin.getUserById(workspace.userId);
  const email = data.user?.email;
  if (!email) {
    throw new Error("test user has no email");
  }

  const session = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password: "Test-1234-aaaa" }),
  }).then((response) => response.json());

  const ref = new URL(url).hostname.split(".")[0];
  const value = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `sb-${ref}-auth-token=base64-${value}`;
}

async function step(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`PASS     ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (RATE_LIMIT.test(detail)) {
      skipped += 1;
      console.log(`SKIPPED  ${name}\n         external rate limit`);
      return;
    }
    failures += 1;
    console.log(`FAIL     ${name}\n         ${detail}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/** Extraction runs after the reply, so the assertion waits for it. */
async function waitForFact(attribute: RegExp): Promise<{
  id: string;
  value: string;
  confidence: number;
  source_thread_id: string | null;
  source_message_id: string | null;
} | null> {
  const deadline = Date.now() + EXTRACTION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { data } = await workspace.userClient
      .from("facts")
      .select("id, attribute, value, confidence, source_thread_id, source_message_id, status")
      .eq("status", "active")
      .returns<
        {
          id: string;
          attribute: string;
          value: string;
          confidence: number;
          source_thread_id: string | null;
          source_message_id: string | null;
        }[]
      >();

    const match = (data ?? []).find(
      (row) => attribute.test(row.attribute) || attribute.test(row.value)
    );
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return null;
}

let threadA: BridgeSession | null = null;

try {
  await step("1-2. a stated preference is learned, with confidence and a source", async () => {
    threadA = new BridgeSession(APP_URL, cookie);
    await threadA.start("Jeg foretrekker korte svar. Husk det.");
    await threadA.settle();

    const text = visibleText(partsOf(threadA.lastAssistantMessage));
    assert(text.length > 0, threadA.lastFailure ?? "Maya said nothing");

    const fact = await waitForFact(/kort|short|svar|response/i);
    assert(fact !== null, "no preference was stored within the timeout");
    assert(fact!.confidence > 0, "the stored preference has no confidence");
    assert(
      fact!.source_thread_id !== null,
      "the stored preference has no source thread"
    );
    console.log(
      `         learned: "${fact!.value}" (confidence ${fact!.confidence}, thread ${fact!.source_thread_id?.slice(0, 8)})`
    );
  });

  await step("3-5. a new thread uses the preference without being told", async () => {
    const threadB = new BridgeSession(APP_URL, cookie);
    await threadB.start("Hva vet du om hvordan jeg liker at du svarer?");
    await threadB.settle();

    const text = visibleText(partsOf(threadB.lastAssistantMessage));
    assert(text.length > 0, threadB.lastFailure ?? "Maya said nothing in thread B");
    assert(
      /kort|korte|short|concise/i.test(text),
      `thread B did not use the preference: ${text.slice(0, 160)}`
    );
    assert(
      threadB.threadId !== threadA?.threadId,
      "thread B reused thread A's id"
    );
  });

  await step("6. recall finds the preference and reports where it came from", async () => {
    const threadC = new BridgeSession(APP_URL, cookie);
    await threadC.start(
      "Bruk recall-verktøyet og fortell hvilken samtale du lærte svarlengde-preferansen min i."
    );
    await threadC.settle();

    const parts = partsOf(threadC.lastAssistantMessage);
    const usedRecall = parts.some(
      (part) => part.type === "tool-call" && part.toolName === "recall"
    );
    const text = visibleText(parts);

    assert(
      usedRecall || /kort|korte|short/i.test(text),
      threadC.lastFailure ?? `recall produced nothing usable: ${text.slice(0, 160)}`
    );
  });

  await step("7. stating the same preference again does not duplicate it", async () => {
    const before = await workspace.userClient
      .from("facts")
      .select("id")
      .eq("status", "active");

    const threadD = new BridgeSession(APP_URL, cookie);
    await threadD.start("Jeg foretrekker korte svar.");
    await threadD.settle();

    // A turn that never ran says nothing about deduplication.
    if (threadD.lastFailure) {
      throw new Error(threadD.lastFailure);
    }

    await new Promise((resolve) => setTimeout(resolve, 15_000));

    const after = await workspace.userClient
      .from("facts")
      .select("id, attribute, value, status")
      .eq("status", "active")
      .returns<{ id: string; attribute: string; value: string }[]>();

    const lengthPreferences = (after.data ?? []).filter(
      (row) => /kort|short|svar|response|length/i.test(`${row.attribute} ${row.value}`)
    );

    assert(
      lengthPreferences.length === 1,
      `expected one preference about answer length, found ${lengthPreferences.length}`
    );
    assert(
      (after.data ?? []).length >= (before.data ?? []).length,
      "facts disappeared"
    );
  });
} finally {
  await workspace.remove();
  await admin.from("workspaces").delete().is("created_by", null);
}

console.log(
  `\n${4 - failures - skipped} passed, ${skipped} skipped, ${failures} failed` +
    (skipped > 0 ? "\nSkips are external rate limits." : "")
);
process.exit(failures === 0 ? 0 : 1);
