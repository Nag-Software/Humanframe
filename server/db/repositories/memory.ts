import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What Maya remembers, for her profile — and the two things a person may do
 * about it: correct a fact, or take it away.
 *
 * Reads and writes go through the user's own client, so row level security
 * decides what is visible and what may change. The agent-side store in
 * `agent/lib/memory-store.ts` is the one that learns; this is the one the
 * user holds.
 */
export type RememberedFact = {
  id: string;
  kind: "fact" | "preference" | "profile";
  attribute: string;
  value: string;
  updatedAt: string;
};

type Row = {
  id: string;
  kind: "fact" | "preference" | "profile";
  attribute: string;
  value: string;
  updated_at: string;
};

type FactRow = Row & {
  workspace_id: string;
  assistant_id: string;
  subject_entity_id: string | null;
  status: "active" | "superseded" | "retracted";
};

export async function listRememberedFacts(
  client: SupabaseClient,
  workspaceId: string,
  assistantId: string,
  limit = 12
): Promise<RememberedFact[]> {
  const { data } = await client
    .from("facts")
    .select("id, kind, attribute, value, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("assistant_id", assistantId)
    .eq("status", "active")
    .order("importance", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit)
    .returns<Row[]>();

  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    attribute: row.attribute,
    value: row.value,
    updatedAt: row.updated_at,
  }));
}

async function readActiveFact(
  client: SupabaseClient,
  workspaceId: string,
  factId: string
): Promise<FactRow | null> {
  const { data } = await client
    .from("facts")
    .select(
      "id, kind, attribute, value, updated_at, workspace_id, assistant_id, subject_entity_id, status"
    )
    .eq("id", factId)
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .maybeSingle<FactRow>();
  return data;
}

/**
 * The mirrored semantic memory for a fact, keyed the way extraction keys it:
 * `kind:subject:attribute`, subject being the entity's name or "self".
 */
async function mirrorKey(
  client: SupabaseClient,
  fact: FactRow
): Promise<string> {
  let subject = "self";
  if (fact.subject_entity_id) {
    const { data: entity } = await client
      .from("entities")
      .select("name")
      .eq("id", fact.subject_entity_id)
      .maybeSingle<{ name: string }>();
    subject = entity?.name.trim().toLowerCase() || "self";
  }
  return `${fact.kind}:${subject}:${fact.attribute.trim().toLowerCase()}`;
}

/**
 * Takes a fact away. The row stays, marked retracted, so the history of what
 * she believed is inspectable; the searchable mirror is removed so it can no
 * longer surface in context.
 */
export async function retractFact(
  client: SupabaseClient,
  workspaceId: string,
  factId: string
): Promise<boolean> {
  const fact = await readActiveFact(client, workspaceId, factId);
  if (!fact) {
    return false;
  }

  const { data: updated } = await client
    .from("facts")
    .update({ status: "retracted", valid_to: new Date().toISOString() })
    .eq("id", fact.id)
    .eq("status", "active")
    .select("id")
    .maybeSingle<{ id: string }>();

  if (!updated) {
    return false;
  }

  await client
    .from("memories")
    .delete()
    .eq("workspace_id", fact.workspace_id)
    .eq("assistant_id", fact.assistant_id)
    .eq("dedupe_key", await mirrorKey(client, fact));

  return true;
}

/**
 * Corrects a fact. The old row is superseded and points at the new one; the
 * new one is active at full confidence, because the user said so themselves.
 * The mirror is updated in place, so the corrected statement is what search
 * finds from now on.
 */
export async function correctFact(
  client: SupabaseClient,
  workspaceId: string,
  factId: string,
  value: string
): Promise<RememberedFact | null> {
  const fact = await readActiveFact(client, workspaceId, factId);
  if (!fact) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === fact.value.trim()) {
    return {
      id: fact.id,
      kind: fact.kind,
      attribute: fact.attribute,
      value: fact.value,
      updatedAt: fact.updated_at,
    };
  }

  // The active-attribute index is unique, so the old row steps aside first.
  const { data: superseded } = await client
    .from("facts")
    .update({ status: "superseded", valid_to: new Date().toISOString() })
    .eq("id", fact.id)
    .eq("status", "active")
    .select("id")
    .maybeSingle<{ id: string }>();

  if (!superseded) {
    return null;
  }

  const { data: inserted, error } = await client
    .from("facts")
    .insert({
      workspace_id: fact.workspace_id,
      assistant_id: fact.assistant_id,
      subject_entity_id: fact.subject_entity_id,
      kind: fact.kind,
      attribute: fact.attribute,
      value: trimmed,
      confidence: 1,
      importance: 0.8,
    })
    .select("id, kind, attribute, value, updated_at")
    .single<Row>();

  if (error || !inserted) {
    // Put the old one back rather than leave the attribute without a value.
    await client
      .from("facts")
      .update({ status: "active", valid_to: null })
      .eq("id", fact.id);
    return null;
  }

  await client
    .from("facts")
    .update({ superseded_by: inserted.id })
    .eq("id", fact.id);

  const key = await mirrorKey(client, fact);
  await client
    .from("memories")
    .update({
      content: `${fact.attribute}: ${trimmed}`,
      confidence: 1,
      importance: 0.8,
    })
    .eq("workspace_id", fact.workspace_id)
    .eq("assistant_id", fact.assistant_id)
    .eq("dedupe_key", key);

  return {
    id: inserted.id,
    kind: inserted.kind,
    attribute: inserted.attribute,
    value: inserted.value,
    updatedAt: inserted.updated_at,
  };
}
