/**
 * Memory tests that make no model calls.
 *
 * They run against Supabase with real users, so row level security is exercised
 * as the database enforces it. Embeddings are handcrafted unit vectors, which
 * makes similarity a property of the test instead of a property of a model.
 *
 *   pnpm test:memory
 */
import {
  dedupeKey,
  storeCandidates,
  type Candidate,
} from "../agent/lib/memory-extraction.ts";
import {
  memoryScore,
  rankMemories,
  setEmbedderForTests,
  type MemoryRow,
  type MemoryScope,
} from "../agent/lib/memory-store.ts";
import { buildContextPackage, CONTEXT_LIMITS } from "../agent/lib/context-package.ts";
import {
  admin,
  blendedVector,
  createTestWorkspace,
  unitVector,
  type TestWorkspace,
} from "./memory-support.mts";

let failures = 0;
const results: string[] = [];

async function test(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    results.push(`PASS  ${name}`);
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    const detail = error instanceof Error ? error.message : String(error);
    results.push(`FAIL  ${name}: ${detail}`);
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function scopeFor(workspace: TestWorkspace): MemoryScope {
  return {
    client: workspace.userClient,
    workspaceId: workspace.workspaceId,
    assistantId: workspace.assistantId,
    userId: workspace.userId,
  };
}

async function insertMemory(
  workspace: TestWorkspace,
  input: {
    content: string;
    embedding: number[];
    importance?: number;
    confidence?: number;
    occurredAt?: string;
    dedupeKey: string;
    threadId?: string | null;
  }
) {
  return workspace.userClient
    .from("memories")
    .upsert(
      {
        workspace_id: workspace.workspaceId,
        assistant_id: workspace.assistantId,
        user_id: workspace.userId,
        kind: "semantic",
        content: input.content,
        embedding: JSON.stringify(input.embedding),
        importance: input.importance ?? 0.5,
        confidence: input.confidence ?? 0.8,
        dedupe_key: input.dedupeKey,
        occurred_at: input.occurredAt ?? new Date().toISOString(),
        source_thread_id: input.threadId ?? null,
      },
      { onConflict: "workspace_id,assistant_id,dedupe_key" }
    )
    .select("id")
    .maybeSingle<{ id: string }>();
}

// No model calls: embeddings are a deterministic function of the text, so the
// write path is exercised without leaving the machine.
setEmbedderForTests(async (text) => {
  let hash = 0;
  for (const character of text) {
    hash = (hash * 31 + character.charCodeAt(0)) % 1536;
  }
  return unitVector(hash);
});

const alice = await createTestWorkspace("a");
const bob = await createTestWorkspace("b");

try {
  // ---------------------------------------------------------------- ranking

  await test("ranking prefers similarity, then importance and recency", () => {
    const now = new Date("2026-09-15T00:00:00Z");
    const base: Omit<MemoryRow, "id" | "similarity" | "importance"> = {
      kind: "semantic",
      content: "x",
      confidence: 0.8,
      occurred_at: now.toISOString(),
      source_thread_id: null,
      source_message_id: null,
    };

    const ranked = rankMemories(
      [
        { ...base, id: "c", similarity: 0.3, importance: 0.9 },
        { ...base, id: "a", similarity: 0.9, importance: 0.2 },
        { ...base, id: "b", similarity: 0.5, importance: 0.9 },
      ],
      now
    );

    assert(
      ranked.map((row) => row.id).join(",") === "a,b,c",
      `unexpected order: ${ranked.map((row) => row.id).join(",")}`
    );
  });

  await test("an older memory scores below an identical newer one", () => {
    const now = new Date("2026-09-15T00:00:00Z");
    const shared = {
      kind: "semantic" as const,
      content: "x",
      importance: 0.5,
      confidence: 0.8,
      similarity: 0.5,
      source_thread_id: null,
      source_message_id: null,
    };

    const fresh = memoryScore(
      { ...shared, id: "new", occurred_at: now.toISOString() },
      now
    );
    const stale = memoryScore(
      { ...shared, id: "old", occurred_at: "2026-01-01T00:00:00Z" },
      now
    );

    assert(fresh > stale, "recency did not affect the score");
  });

  await test("ranking is stable for identical scores", () => {
    const now = new Date("2026-09-15T00:00:00Z");
    const row = (id: string): MemoryRow => ({
      id,
      kind: "semantic",
      content: "x",
      importance: 0.5,
      confidence: 0.5,
      similarity: 0.5,
      occurred_at: now.toISOString(),
      source_thread_id: null,
      source_message_id: null,
    });

    const first = rankMemories([row("b"), row("a"), row("c")], now);
    const second = rankMemories([row("c"), row("b"), row("a")], now);
    assert(
      first.map((r) => r.id).join() === second.map((r) => r.id).join(),
      "ranking is not deterministic"
    );
  });

  // --------------------------------------------------------- vector search

  await test("vector search returns the closest memory first", async () => {
    await insertMemory(alice, {
      content: "The user prefers short answers",
      embedding: unitVector(0),
      dedupeKey: "pref:self:response length",
      importance: 0.9,
    });
    await insertMemory(alice, {
      content: "The user runs a company called Nag Software",
      embedding: unitVector(1),
      dedupeKey: "fact:self:employer",
    });

    const { data, error } = await alice.userClient.rpc("match_memories", {
      target_workspace: alice.workspaceId,
      target_assistant: alice.assistantId,
      query_embedding: JSON.stringify(blendedVector(0, 1, 0.95)),
      match_limit: 5,
      min_similarity: 0.1,
    });

    assert(!error, `rpc failed: ${error?.message}`);
    const rows = (data ?? []) as MemoryRow[];
    assert(rows.length === 2, `expected 2 rows, got ${rows.length}`);
    assert(
      rows[0].content.includes("short answers"),
      `closest row was: ${rows[0].content}`
    );
  });

  await test("min_similarity and match_limit bound the result set", async () => {
    const { data: filtered } = await alice.userClient.rpc("match_memories", {
      target_workspace: alice.workspaceId,
      target_assistant: alice.assistantId,
      query_embedding: JSON.stringify(unitVector(0)),
      match_limit: 5,
      min_similarity: 0.9,
    });
    assert(
      ((filtered ?? []) as MemoryRow[]).length === 1,
      "min_similarity did not filter the orthogonal memory"
    );

    const { data: limited } = await alice.userClient.rpc("match_memories", {
      target_workspace: alice.workspaceId,
      target_assistant: alice.assistantId,
      query_embedding: JSON.stringify(unitVector(0)),
      match_limit: 1,
      min_similarity: 0,
    });
    assert(
      ((limited ?? []) as MemoryRow[]).length === 1,
      "match_limit was not honoured"
    );
  });

  // ------------------------------------------------------------------- RLS

  await test("another workspace cannot read or write these memories", async () => {
    const { data: leaked } = await bob.userClient
      .from("memories")
      .select("id, content");
    assert(
      (leaked ?? []).length === 0,
      `workspace B read ${(leaked ?? []).length} of workspace A's memories`
    );

    const { data: crossSearch } = await bob.userClient.rpc("match_memories", {
      target_workspace: alice.workspaceId,
      target_assistant: alice.assistantId,
      query_embedding: JSON.stringify(unitVector(0)),
      match_limit: 5,
      min_similarity: 0,
    });
    assert(
      ((crossSearch ?? []) as MemoryRow[]).length === 0,
      "match_memories leaked across workspaces"
    );

    const forged = await bob.userClient.from("memories").insert({
      workspace_id: alice.workspaceId,
      assistant_id: alice.assistantId,
      kind: "semantic",
      content: "forged",
      dedupe_key: "forged:self:x",
    });
    assert(
      forged.error !== null,
      "workspace B was allowed to write into workspace A"
    );

    const anon = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/rest/v1/memories?select=id`,
      { headers: { apikey: "" } }
    ).catch(() => null);
    assert(anon === null || anon.status !== 200, "memories are readable anonymously");
  });

  // ----------------------------------------------------- dedupe and conflict

  await test("the same memory stored twice stays one row", async () => {
    const key = "fact:self:favourite editor";
    await insertMemory(alice, {
      content: "Uses Zed",
      embedding: unitVector(2),
      dedupeKey: key,
    });
    await insertMemory(alice, {
      content: "Uses Zed",
      embedding: unitVector(2),
      dedupeKey: key,
    });

    const { data } = await alice.userClient
      .from("memories")
      .select("id")
      .eq("dedupe_key", key);
    assert((data ?? []).length === 1, `expected 1 row, got ${(data ?? []).length}`);
  });

  await test("a new value supersedes the old fact and keeps the link", async () => {
    const scope = scopeFor(alice);
    const first: Candidate = {
      kind: "preference",
      subject: null,
      subjectKind: null,
      attribute: "response length",
      value: "short answers",
      confidence: 0.9,
      importance: 0.8,
    };

    await storeCandidates(scope, [first], {
      threadId: null,
      messageId: null,
      occurredAt: new Date().toISOString(),
    });

    await storeCandidates(
      scope,
      [{ ...first, value: "detailed answers with examples" }],
      { threadId: null, messageId: null, occurredAt: new Date().toISOString() }
    );

    const { data: rows } = await alice.userClient
      .from("facts")
      .select("id, value, status, superseded_by")
      .ilike("attribute", "response length")
      .returns<
        { id: string; value: string; status: string; superseded_by: string | null }[]
      >();

    const active = (rows ?? []).filter((row) => row.status === "active");
    const superseded = (rows ?? []).filter((row) => row.status === "superseded");

    assert(active.length === 1, `expected one active fact, got ${active.length}`);
    assert(
      active[0].value.includes("detailed"),
      `active fact is stale: ${active[0].value}`
    );
    assert(superseded.length === 1, "the old fact was not superseded");
    assert(
      superseded[0].superseded_by === active[0].id,
      "the superseded fact does not point at its replacement"
    );
  });

  await test("re-running the same extraction creates nothing new", async () => {
    const scope = scopeFor(alice);
    const candidate: Candidate = {
      kind: "fact",
      subject: null,
      subjectKind: null,
      attribute: "employer",
      value: "Nag Software",
      confidence: 0.9,
      importance: 0.7,
    };
    const source = {
      threadId: null,
      messageId: null,
      occurredAt: "2026-09-15T10:00:00.000Z",
    };

    await storeCandidates(scope, [candidate], source);
    await storeCandidates(scope, [candidate], source);

    const { data } = await alice.userClient
      .from("facts")
      .select("id")
      .ilike("attribute", "employer");
    assert((data ?? []).length === 1, `expected 1 fact, got ${(data ?? []).length}`);
  });

  await test("low-confidence candidates are skipped", async () => {
    const result = await storeCandidates(
      scopeFor(alice),
      [
        {
          kind: "fact",
          subject: null,
          subjectKind: null,
          attribute: "maybe",
          value: "unsure",
          confidence: 0.2,
          importance: 0.5,
        },
      ],
      { threadId: null, messageId: null, occurredAt: new Date().toISOString() }
    );
    assert(result.skipped === 1 && result.stored === 0, "a guess was stored");
  });

  await test("the dedupe key ignores wording and casing of the subject", () => {
    const base: Candidate = {
      kind: "fact",
      subject: null,
      subjectKind: null,
      attribute: "Employer",
      value: "Nag Software",
      confidence: 0.9,
      importance: 0.7,
    };
    assert(
      dedupeKey(base) === dedupeKey({ ...base, attribute: "employer" }),
      "dedupe key is case sensitive"
    );
    assert(
      dedupeKey(base) !== dedupeKey({ ...base, subject: "Ada" }),
      "different subjects share a dedupe key"
    );
  });


  // -------------------------------------------------------------- entities

  await test("a subject becomes one entity, however often it is mentioned", async () => {
    const scope = scopeFor(alice);
    const candidate: Candidate = {
      kind: "fact",
      subject: "Nag Software",
      subjectKind: "company",
      attribute: "role",
      value: "The user's own company",
      confidence: 0.9,
      importance: 0.7,
    };
    const source = {
      threadId: null,
      messageId: null,
      occurredAt: new Date().toISOString(),
    };

    await storeCandidates(scope, [candidate], source);
    // Same subject, different spacing and casing: still one entity.
    await storeCandidates(
      scope,
      [{ ...candidate, subject: "  nag   SOFTWARE ", value: "Same company" }],
      source
    );

    const { data } = await alice.userClient
      .from("entities")
      .select("id, name, normalized_name, kind")
      .eq("kind", "company")
      .returns<
        { id: string; name: string; normalized_name: string; kind: string }[]
      >();

    const nag = (data ?? []).filter((row) =>
      row.normalized_name.includes("nag software")
    );
    assert(nag.length === 1, `expected one entity, got ${nag.length}`);
    assert(
      nag[0].normalized_name === "nag software",
      `normalisation is wrong: "${nag[0].normalized_name}"`
    );
  });

  await test("the same name under a different kind is a different entity", async () => {
    const scope = scopeFor(alice);
    const source = {
      threadId: null,
      messageId: null,
      occurredAt: new Date().toISOString(),
    };

    await storeCandidates(
      scope,
      [
        {
          kind: "fact",
          subject: "Atlas",
          subjectKind: "project",
          attribute: "status",
          value: "In progress",
          confidence: 0.8,
          importance: 0.6,
        },
        {
          kind: "fact",
          subject: "Atlas",
          subjectKind: "person",
          attribute: "role",
          value: "Designer",
          confidence: 0.8,
          importance: 0.6,
        },
      ],
      source
    );

    const { data } = await alice.userClient
      .from("entities")
      .select("kind")
      .eq("normalized_name", "atlas")
      .returns<{ kind: string }[]>();

    assert((data ?? []).length === 2, `expected 2 entities, got ${(data ?? []).length}`);
  });

  await test("facts about an entity hang off that entity", async () => {
    const { data: entity } = await alice.userClient
      .from("entities")
      .select("id")
      .eq("normalized_name", "nag software")
      .eq("assistant_id", alice.assistantId)
      .maybeSingle<{ id: string }>();

    assert(entity !== null, "the company entity is missing");

    const { data: facts } = await alice.userClient
      .from("facts")
      .select("id, subject_entity_id, status")
      .eq("subject_entity_id", entity!.id)
      .eq("status", "active")
      .returns<{ id: string }[]>();

    assert((facts ?? []).length >= 1, "no fact is attached to the entity");
  });

  await test("episodes link to their entity exactly once", async () => {
    const scope = scopeFor(alice);
    const candidate: Candidate = {
      kind: "episode",
      subject: "Ada Lovelace",
      subjectKind: "person",
      attribute: "meeting",
      value: "Reviewed the roadmap together",
      confidence: 0.8,
      importance: 0.6,
    };
    const source = {
      threadId: null,
      messageId: null,
      occurredAt: new Date().toISOString(),
    };

    await storeCandidates(scope, [candidate], source);
    await storeCandidates(scope, [candidate], source);

    const { data: entity } = await alice.userClient
      .from("entities")
      .select("id")
      .eq("normalized_name", "ada lovelace")
      .maybeSingle<{ id: string }>();
    assert(entity !== null, "the person entity is missing");

    const { data: links } = await alice.userClient
      .from("memory_entities")
      .select("memory_id, entity_id")
      .eq("entity_id", entity!.id);

    assert(
      (links ?? []).length === 1,
      `expected one link, got ${(links ?? []).length}`
    );
  });

  await test("a second assistant keeps its own entities", async () => {
    const { data: second } = await admin
      .from("assistants")
      .insert({
        workspace_id: alice.workspaceId,
        slug: "atlas",
        name: "Atlas",
        role: "Analyst",
      })
      .select("id")
      .maybeSingle<{ id: string }>();

    assert(second !== null, "could not create a second assistant");

    await storeCandidates(
      {
        client: alice.userClient,
        workspaceId: alice.workspaceId,
        assistantId: second!.id,
        userId: alice.userId,
      },
      [
        {
          kind: "fact",
          subject: "Nag Software",
          subjectKind: "company",
          attribute: "role",
          value: "Client of the second assistant",
          confidence: 0.9,
          importance: 0.6,
        },
      ],
      { threadId: null, messageId: null, occurredAt: new Date().toISOString() }
    );

    const { data } = await alice.userClient
      .from("entities")
      .select("id, assistant_id")
      .eq("normalized_name", "nag software")
      .returns<{ id: string; assistant_id: string }[]>();

    assert(
      (data ?? []).length === 2,
      `each assistant should own its entity row; got ${(data ?? []).length}`
    );
  });

  await test("entities do not cross workspaces", async () => {
    const { data: leaked } = await bob.userClient.from("entities").select("id");
    assert(
      (leaked ?? []).length === 0,
      `workspace B read ${(leaked ?? []).length} entities from workspace A`
    );

    const forged = await bob.userClient.from("entities").insert({
      workspace_id: alice.workspaceId,
      assistant_id: alice.assistantId,
      kind: "company",
      name: "Forged",
    });
    assert(forged.error !== null, "workspace B wrote an entity into workspace A");
  });

  // ------------------------------------------------------- context package

  await test("the context package carries sources and stays within budget", async () => {
    const scope = scopeFor(alice);

    for (let index = 0; index < 30; index += 1) {
      await alice.userClient.from("facts").insert({
        workspace_id: alice.workspaceId,
        assistant_id: alice.assistantId,
        kind: "fact",
        attribute: `filler ${index}`,
        value: "x".repeat(200),
        confidence: 0.9,
        importance: 0.4,
      });
    }

    const context = await buildContextPackage(scope, { message: null });
    assert(context !== null, "no context was built");
    assert(
      context!.text.length <= CONTEXT_LIMITS.characters + 2,
      `context exceeded its budget: ${context!.text.length}`
    );
    assert(
      context!.text.includes("Preferences"),
      "preferences are missing from the context"
    );
    assert(
      /\[memory:[0-9a-f-]{36}/.test(context!.text),
      "context does not cite memory ids"
    );
  });

  await test("a workspace with no memory gets no context package", async () => {
    const context = await buildContextPackage(scopeFor(bob), { message: null });
    assert(context === null, "an empty workspace produced context");
  });
} finally {
  await alice.remove();
  await bob.remove();
  await admin.from("workspaces").delete().is("created_by", null);
}

console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures === 0 ? 0 : 1);
