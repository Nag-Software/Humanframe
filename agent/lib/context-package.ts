import {
  listActiveFacts,
  listDecisions,
  listEntities,
  searchMemories,
  type MemoryScope,
  type MemoryRow,
} from "./memory-store";

/**
 * The context package injected before a turn.
 *
 * It is deliberately small and deterministic: profile and preferences first
 * because they change how Maya answers, then the entities and decisions that
 * give a conversation its nouns, then the few memories that match what the
 * user just said. Conversation history is not repeated here — eve already owns
 * it.
 */
const LIMITS = {
  facts: 12,
  entities: 6,
  decisions: 4,
  memories: 5,
  /** A rough ceiling; four characters per token is close enough for a budget. */
  characters: 3200,
} as const;

export type ContextPackage = {
  text: string;
  memoryIds: string[];
  truncated: boolean;
};

export async function buildContextPackage(
  scope: MemoryScope,
  input: { message: string | null }
): Promise<ContextPackage | null> {
  const [facts, entities, decisions, memories] = await Promise.all([
    listActiveFacts(scope, LIMITS.facts),
    listEntities(scope, LIMITS.entities),
    listDecisions(scope, LIMITS.decisions),
    input.message
      ? searchMemories(scope, { query: input.message, limit: LIMITS.memories })
      : Promise.resolve<MemoryRow[]>([]),
  ]);

  if (
    facts.length === 0 &&
    entities.length === 0 &&
    decisions.length === 0 &&
    memories.length === 0
  ) {
    return null;
  }

  const sections: string[] = ["# What you remember about this user"];

  const profile = facts.filter((fact) => fact.kind === "profile");
  const preferences = facts.filter((fact) => fact.kind === "preference");
  const plain = facts.filter((fact) => fact.kind === "fact");

  if (profile.length > 0) {
    sections.push(
      "## Profile",
      ...profile.map((fact) => `- ${fact.attribute}: ${fact.value}`)
    );
  }

  if (preferences.length > 0) {
    sections.push(
      "## Preferences (follow these unless the user says otherwise)",
      ...preferences.map(
        (fact) =>
          `- ${fact.attribute}: ${fact.value} [memory:${fact.id}, confidence ${fact.confidence.toFixed(2)}]`
      )
    );
  }

  if (plain.length > 0) {
    sections.push(
      "## Facts",
      ...plain.map(
        (fact) =>
          `- ${fact.attribute}: ${fact.value} [memory:${fact.id}, confidence ${fact.confidence.toFixed(2)}]`
      )
    );
  }

  if (entities.length > 0) {
    sections.push(
      "## People, companies and projects",
      ...entities.map((entity) => `- ${entity.name} (${entity.kind})`)
    );
  }

  if (decisions.length > 0) {
    sections.push(
      "## Decisions",
      ...decisions.map(
        (decision) =>
          `- ${decision.statement} [memory:${decision.id}, ${decision.decided_at.slice(0, 10)}]`
      )
    );
  }

  if (memories.length > 0) {
    sections.push(
      "## Relevant memories",
      ...memories.map(
        (memory) =>
          `- ${memory.content} [memory:${memory.id}, ${memory.occurred_at.slice(0, 10)}]`
      )
    );
  }

  sections.push(
    "",
    "Use this as your own recollection: state it naturally, never as a database lookup.",
    "Cite a source only when the user asks where something came from, by referring to the conversation it happened in.",
    "If something here is contradicted by what the user says now, the user is right and the newer information wins.",
    "Call `recall` only when you need detail that is not in this list."
  );

  const full = sections.join("\n");
  const truncated = full.length > LIMITS.characters;

  return {
    text: truncated ? `${full.slice(0, LIMITS.characters)}\n…` : full,
    memoryIds: memories.map((memory) => memory.id),
    truncated,
  };
}

export const CONTEXT_LIMITS = LIMITS;
