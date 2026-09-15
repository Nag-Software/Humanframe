import { generateObject } from "ai";
import { z } from "zod";

import { embedText, type MemoryScope } from "./memory-store";
import { memoryModel, normalizeEntityName } from "./models";

/**
 * Turns a finished exchange into durable memory.
 *
 * The model proposes candidates; this module decides what to store. Writes are
 * keyed on a dedupe key derived from the statement itself, so the same fact
 * learned twice updates one row, and a retried hook writes nothing new.
 */
const candidateSchema = z.object({
  memories: z
    .array(
      z.object({
        kind: z.enum(["fact", "preference", "profile", "decision", "episode"]),
        // Nullable rather than optional: structured outputs require every
        // property to be present, so "no subject" has to be an explicit null.
        subject: z
          .string()
          .max(120)
          .nullable()
          .describe("Person, company or project this is about, or null"),
        subjectKind: z
          .enum(["person", "company", "project", "place", "other"])
          .nullable()
          .describe("What the subject is, or null when there is no subject"),
        attribute: z
          .string()
          .max(120)
          .describe("Short key, e.g. 'response length' or 'employer'"),
        value: z.string().max(400).describe("The statement itself"),
        confidence: z.number().min(0).max(1),
        importance: z.number().min(0).max(1),
      })
    )
    .max(8),
});

export type Candidate = z.infer<typeof candidateSchema>["memories"][number];

const EXTRACTION_PROMPT = `You maintain an assistant's long-term memory of one user.

Extract only durable knowledge that would still matter in a week: stated
preferences, profile details, relationships, commitments the user described,
explicit decisions, and events worth remembering.

Ignore greetings, small talk, thanks, the assistant's own suggestions, anything
the user asked hypothetically, and anything already obvious from the assistant's
role. If nothing durable was said, return an empty list.

Confidence reflects how explicitly the user stated it: 0.9 for "I prefer X",
0.5 for something implied. Importance reflects how much it should shape future
answers.`;

export async function extractCandidates(input: {
  userText: string;
  assistantText: string;
}): Promise<Candidate[]> {
  const { object } = await generateObject({
    model: memoryModel(),
    schema: candidateSchema,
    system: EXTRACTION_PROMPT,
    prompt: `User said:\n${input.userText}\n\nAssistant replied:\n${input.assistantText}`,
  });

  return object.memories;
}

/** Below this, extraction is skipped rather than calling the model for nothing. */
export const MIN_USER_CHARACTERS = 12;

export type MemorySource = {
  threadId: string | null;
  messageId: string | null;
  occurredAt: string;
};

export type StoreResult = {
  stored: number;
  superseded: number;
  skipped: number;
  entities: number;
};

/**
 * The full extract-and-store pass. Callers that sit on a user-visible path
 * must not await this: it is a model call plus embeddings.
 */
export async function learnFromExchange(input: {
  userText: string;
  assistantText: string;
  scope: MemoryScope;
  source: MemorySource;
}): Promise<StoreResult | null> {
  if (input.userText.trim().length < MIN_USER_CHARACTERS) {
    return null;
  }

  const candidates = await extractCandidates({
    userText: input.userText,
    assistantText: input.assistantText,
  });

  if (candidates.length === 0) {
    return null;
  }

  const result = await storeCandidates(input.scope, candidates, input.source);
  await mirrorFactsIntoMemories(input.scope, candidates, input.source);
  return result;
}

/** Stable across retries and re-extractions of the same statement. */
export function dedupeKey(candidate: Candidate): string {
  const subject = (candidate.subject ?? "self").trim().toLowerCase() || "self";
  const attribute = candidate.attribute.trim().toLowerCase();
  return `${candidate.kind}:${subject}:${attribute}`;
}

export async function storeCandidates(
  scope: MemoryScope,
  candidates: Candidate[],
  source: { threadId: string | null; messageId: string | null; occurredAt: string }
): Promise<StoreResult> {
  const result: StoreResult = { stored: 0, superseded: 0, skipped: 0, entities: 0 };

  for (const candidate of candidates) {
    if (candidate.confidence < 0.4) {
      result.skipped += 1;
      continue;
    }

    const entityId = await upsertEntity(scope, candidate, source);
    if (entityId) {
      result.entities += 1;
    }

    if (
      candidate.kind === "fact" ||
      candidate.kind === "preference" ||
      candidate.kind === "profile"
    ) {
      const superseded = await upsertFact(scope, candidate, source, entityId);
      result.stored += 1;
      result.superseded += superseded ? 1 : 0;
      continue;
    }

    if (candidate.kind === "decision") {
      await insertDecision(scope, candidate, source);
      result.stored += 1;
      continue;
    }

    const memoryId = await upsertMemory(scope, candidate, source);
    await linkMemoryToEntity(scope, memoryId, entityId);
    result.stored += 1;
  }

  return result;
}

/**
 * Upserts the person, company or project a candidate is about.
 *
 * Identity is (workspace, assistant, kind, normalized name) — the same key the
 * database enforces — so the same subject named twice lands on one row. Names
 * are normalised deterministically and never matched fuzzily: "Ada L." and
 * "Ada Lovelace" stay two entities until someone decides they are one.
 */
async function upsertEntity(
  scope: MemoryScope,
  candidate: Candidate,
  source: { threadId: string | null; messageId: string | null }
): Promise<string | null> {
  // Collapse whitespace but keep the user's capitalisation: the display name
  // stays human, while normalized_name carries identity.
  const name = candidate.subject?.replace(/\s+/g, " ").trim();
  if (!name || normalizeEntityName(name).length === 0) {
    return null;
  }

  const kind = candidate.subjectKind ?? "other";

  const { data, error } = await scope.client
    .from("entities")
    .upsert(
      {
        workspace_id: scope.workspaceId,
        assistant_id: scope.assistantId,
        kind,
        name,
        importance: candidate.importance,
        source_thread_id: source.threadId,
        source_message_id: source.messageId,
      },
      {
        onConflict: "workspace_id,assistant_id,kind,normalized_name",
        ignoreDuplicates: false,
      }
    )
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`entity write failed: ${error.message}`);
  }

  return data?.id ?? null;
}

/** The join is a primary key, so re-linking the same pair changes nothing. */
async function linkMemoryToEntity(
  scope: MemoryScope,
  memoryId: string | null,
  entityId: string | null
): Promise<void> {
  if (!memoryId || !entityId) {
    return;
  }

  await scope.client
    .from("memory_entities")
    .upsert(
      { memory_id: memoryId, entity_id: entityId },
      { onConflict: "memory_id,entity_id", ignoreDuplicates: true }
    );
}

/**
 * A newer value does not sit beside the old one: the previous active fact is
 * marked superseded and points at its replacement, so a contradiction is
 * recorded rather than silently resolved.
 */
async function upsertFact(
  scope: MemoryScope,
  candidate: Candidate,
  source: { threadId: string | null; messageId: string | null },
  entityId: string | null
): Promise<boolean> {
  const kind = candidate.kind as "fact" | "preference" | "profile";
  const attribute = candidate.attribute.trim();

  const existingQuery = scope.client
    .from("facts")
    .select("id, value")
    .eq("workspace_id", scope.workspaceId)
    .eq("assistant_id", scope.assistantId)
    .eq("kind", kind)
    .eq("status", "active")
    .ilike("attribute", attribute);

  const { data: existing } = await (entityId
    ? existingQuery.eq("subject_entity_id", entityId)
    : existingQuery.is("subject_entity_id", null)
  ).maybeSingle<{ id: string; value: string }>();

  if (existing && existing.value.trim() === candidate.value.trim()) {
    // Same statement again: refresh confidence, create nothing.
    await scope.client
      .from("facts")
      .update({
        confidence: candidate.confidence,
        importance: candidate.importance,
      })
      .eq("id", existing.id);
    return false;
  }

  if (existing) {
    await scope.client
      .from("facts")
      .update({ status: "superseded", valid_to: new Date().toISOString() })
      .eq("id", existing.id);
  }

  const { data: inserted, error: insertError } = await scope.client
    .from("facts")
    .insert({
      workspace_id: scope.workspaceId,
      assistant_id: scope.assistantId,
      kind,
      attribute,
      value: candidate.value.trim(),
      subject_entity_id: entityId,
      confidence: candidate.confidence,
      importance: candidate.importance,
      source_thread_id: source.threadId,
      source_message_id: source.messageId,
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (insertError) {
    throw new Error(`fact write failed: ${insertError.message}`);
  }

  if (existing && inserted) {
    await scope.client
      .from("facts")
      .update({ superseded_by: inserted.id })
      .eq("id", existing.id);
    return true;
  }

  return false;
}

async function insertDecision(
  scope: MemoryScope,
  candidate: Candidate,
  source: { threadId: string | null; messageId: string | null }
): Promise<void> {
  await scope.client.from("decisions").insert({
    workspace_id: scope.workspaceId,
    assistant_id: scope.assistantId,
    statement: candidate.value.trim(),
    rationale: candidate.subject ?? null,
    importance: candidate.importance,
    confidence: candidate.confidence,
    source_thread_id: source.threadId,
    source_message_id: source.messageId,
  });
}

async function upsertMemory(
  scope: MemoryScope,
  candidate: Candidate,
  source: { threadId: string | null; messageId: string | null; occurredAt: string }
): Promise<string | null> {
  const content = candidate.subject
    ? `${candidate.subject} — ${candidate.attribute}: ${candidate.value}`
    : `${candidate.attribute}: ${candidate.value}`;

  const embedding = await embedText(content);

  const { data } = await scope.client.from("memories").upsert(
    {
      workspace_id: scope.workspaceId,
      assistant_id: scope.assistantId,
      user_id: scope.userId,
      kind: "episodic",
      content,
      embedding: JSON.stringify(embedding),
      importance: candidate.importance,
      confidence: candidate.confidence,
      dedupe_key: dedupeKey(candidate),
      source_thread_id: source.threadId,
      source_message_id: source.messageId,
      occurred_at: source.occurredAt,
    },
    { onConflict: "workspace_id,assistant_id,dedupe_key" }
  )
    .select("id")
    .maybeSingle<{ id: string }>();

  return data?.id ?? null;
}

/**
 * Facts are the load-bearing memory, so they are also embedded and mirrored
 * into `memories`. That keeps one retrieval path — semantic search — instead
 * of two, while `facts` stays the structured source of truth.
 */
export async function mirrorFactsIntoMemories(
  scope: MemoryScope,
  candidates: Candidate[],
  source: { threadId: string | null; messageId: string | null; occurredAt: string }
): Promise<void> {
  for (const candidate of candidates) {
    if (
      candidate.kind !== "fact" &&
      candidate.kind !== "preference" &&
      candidate.kind !== "profile"
    ) {
      continue;
    }
    if (candidate.confidence < 0.4) {
      continue;
    }

    const content = `${candidate.attribute}: ${candidate.value}`;
    const embedding = await embedText(content);

    await scope.client.from("memories").upsert(
      {
        workspace_id: scope.workspaceId,
        assistant_id: scope.assistantId,
        user_id: scope.userId,
        kind: "semantic",
        content,
        embedding: JSON.stringify(embedding),
        importance: candidate.importance,
        confidence: candidate.confidence,
        dedupe_key: dedupeKey(candidate),
        source_thread_id: source.threadId,
        source_message_id: source.messageId,
        occurred_at: source.occurredAt,
      },
      { onConflict: "workspace_id,assistant_id,dedupe_key" }
    );
  }
}
