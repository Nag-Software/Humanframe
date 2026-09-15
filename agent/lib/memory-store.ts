import type { SupabaseClient } from "@supabase/supabase-js";
import { embed } from "ai";

import { embeddingModel } from "./models";

/**
 * Memory reads and writes for the agent runtime.
 *
 * Hooks and tools run outside any request, so these helpers take the workspace
 * and assistant explicitly and filter on both in every statement. Nothing here
 * accepts a caller-supplied scope: it always comes from the resolved session.
 */
export type MemoryScope = {
  client: SupabaseClient;
  workspaceId: string;
  assistantId: string;
  userId: string;
};

export type FactRow = {
  id: string;
  kind: "fact" | "preference" | "profile";
  attribute: string;
  value: string;
  confidence: number;
  importance: number;
  source_thread_id: string | null;
  source_message_id: string | null;
  updated_at: string;
};

export type MemoryRow = {
  id: string;
  kind: "episodic" | "semantic";
  content: string;
  importance: number;
  confidence: number;
  occurred_at: string;
  source_thread_id: string | null;
  source_message_id: string | null;
  similarity?: number;
};

export type EntityRow = {
  id: string;
  kind: string;
  name: string;
  attributes: Record<string, unknown>;
  importance: number;
};

export type DecisionRow = {
  id: string;
  statement: string;
  rationale: string | null;
  decided_at: string;
  importance: number;
  source_thread_id: string | null;
  source_message_id: string | null;
};

/**
 * Test seam. The deterministic suite substitutes a pure function here so it can
 * exercise the write path without a model call; production never sets it.
 */
let embedderOverride: ((text: string) => Promise<number[]>) | null = null;

export function setEmbedderForTests(
  embedder: ((text: string) => Promise<number[]>) | null
): void {
  embedderOverride = embedder;
}

export async function embedText(text: string): Promise<number[]> {
  const value = text.slice(0, 8000);
  if (embedderOverride) {
    return embedderOverride(value);
  }

  const { embedding } = await embed({ model: embeddingModel(), value });
  return embedding;
}

export async function listActiveFacts(
  scope: MemoryScope,
  limit = 20
): Promise<FactRow[]> {
  const { data } = await scope.client
    .from("facts")
    .select(
      "id, kind, attribute, value, confidence, importance, source_thread_id, source_message_id, updated_at"
    )
    .eq("workspace_id", scope.workspaceId)
    .eq("assistant_id", scope.assistantId)
    .eq("status", "active")
    .order("importance", { ascending: false })
    .order("confidence", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit)
    .returns<FactRow[]>();

  return data ?? [];
}

export async function listEntities(
  scope: MemoryScope,
  limit = 10
): Promise<EntityRow[]> {
  const { data } = await scope.client
    .from("entities")
    .select("id, kind, name, attributes, importance")
    .eq("workspace_id", scope.workspaceId)
    .eq("assistant_id", scope.assistantId)
    .order("importance", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit)
    .returns<EntityRow[]>();

  return data ?? [];
}

export async function listDecisions(
  scope: MemoryScope,
  limit = 5
): Promise<DecisionRow[]> {
  const { data } = await scope.client
    .from("decisions")
    .select(
      "id, statement, rationale, decided_at, importance, source_thread_id, source_message_id"
    )
    .eq("workspace_id", scope.workspaceId)
    .eq("assistant_id", scope.assistantId)
    .eq("status", "active")
    .order("decided_at", { ascending: false })
    .limit(limit)
    .returns<DecisionRow[]>();

  return data ?? [];
}

/**
 * Semantic search over consolidated memories, ranked by a blend of similarity,
 * importance, confidence and recency. The vector search runs in Postgres; the
 * blend runs here so the weights are visible and testable.
 */
export async function searchMemories(
  scope: MemoryScope,
  input: { query: string; limit?: number; minSimilarity?: number }
): Promise<MemoryRow[]> {
  const limit = input.limit ?? 5;
  const embedding = await embedText(input.query);

  const { data } = await scope.client.rpc("match_memories", {
    target_workspace: scope.workspaceId,
    target_assistant: scope.assistantId,
    query_embedding: JSON.stringify(embedding),
    match_limit: Math.max(limit * 3, 10),
    min_similarity: input.minSimilarity ?? 0.15,
  });

  return rankMemories((data ?? []) as MemoryRow[]).slice(0, limit);
}

/**
 * Deterministic ranking. Similarity decides relevance, importance and
 * confidence decide whether a memory is worth the tokens, and recency breaks
 * near-ties so newer knowledge wins. Ties fall back to id for a stable order.
 */
export function rankMemories(
  rows: MemoryRow[],
  now = new Date()
): MemoryRow[] {
  return [...rows]
    .map((row) => ({ row, score: memoryScore(row, now) }))
    .sort((a, b) =>
      b.score === a.score ? a.row.id.localeCompare(b.row.id) : b.score - a.score
    )
    .map((entry) => entry.row);
}

export function memoryScore(row: MemoryRow, now = new Date()): number {
  const ageDays =
    (now.getTime() - new Date(row.occurred_at).getTime()) / 86_400_000;
  // Half-life of 60 days: a memory keeps most of its weight for two months.
  const recency = Math.exp(-Math.max(ageDays, 0) / 60);

  return (
    0.55 * (row.similarity ?? 0) +
    0.2 * row.importance +
    0.15 * row.confidence +
    0.1 * recency
  );
}
