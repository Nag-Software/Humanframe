-- Long-term memory: entities, facts, decisions and consolidated memories.
--
-- Raw messages stay in `messages` and are never embedded. Only consolidated
-- memories carry a vector, and every memory keeps the thread and message it
-- came from so Maya can say where she learned something.

create extension if not exists vector;

-- ------------------------------------------------------------- entities

create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid not null references public.assistants (id) on delete cascade,
  kind text not null default 'person'
    check (kind in ('person', 'company', 'project', 'place', 'other')),
  name text not null,
  aliases text[] not null default '{}',
  attributes jsonb not null default '{}'::jsonb,
  importance real not null default 0.5 check (importance between 0 and 1),
  source_thread_id uuid references public.threads (id) on delete set null,
  source_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists entities_identity_idx
  on public.entities (workspace_id, assistant_id, kind, lower(name));
create index if not exists entities_workspace_idx
  on public.entities (workspace_id, assistant_id, updated_at desc);

-- ---------------------------------------------------------------- facts

-- Structured, durable statements: profile details, preferences, relationships.
create table if not exists public.facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid not null references public.assistants (id) on delete cascade,
  subject_entity_id uuid references public.entities (id) on delete set null,
  kind text not null default 'fact' check (kind in ('fact', 'preference', 'profile')),
  attribute text not null,
  value text not null,
  confidence real not null default 0.6 check (confidence between 0 and 1),
  importance real not null default 0.5 check (importance between 0 and 1),
  status text not null default 'active'
    check (status in ('active', 'superseded', 'retracted')),
  superseded_by uuid references public.facts (id) on delete set null,
  source_thread_id uuid references public.threads (id) on delete set null,
  source_message_id uuid,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active statement per attribute: a new value supersedes the old one
-- rather than sitting beside it.
create unique index if not exists facts_active_attribute_idx
  on public.facts (workspace_id, assistant_id, kind, lower(attribute))
  where status = 'active' and subject_entity_id is null;
create unique index if not exists facts_active_entity_attribute_idx
  on public.facts (workspace_id, assistant_id, subject_entity_id, kind, lower(attribute))
  where status = 'active' and subject_entity_id is not null;
create index if not exists facts_lookup_idx
  on public.facts (workspace_id, assistant_id, status, importance desc, confidence desc);

-- ------------------------------------------------------------ decisions

create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid not null references public.assistants (id) on delete cascade,
  statement text not null,
  rationale text,
  status text not null default 'active'
    check (status in ('active', 'superseded', 'reversed')),
  supersedes uuid references public.decisions (id) on delete set null,
  superseded_by uuid references public.decisions (id) on delete set null,
  importance real not null default 0.6 check (importance between 0 and 1),
  confidence real not null default 0.7 check (confidence between 0 and 1),
  decided_at timestamptz not null default now(),
  source_thread_id uuid references public.threads (id) on delete set null,
  source_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists decisions_lookup_idx
  on public.decisions (workspace_id, assistant_id, status, decided_at desc);

-- ------------------------------------------------------------- memories

-- Consolidated episodic and semantic memory. This is the only embedded table.
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid not null references public.assistants (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  kind text not null default 'episodic' check (kind in ('episodic', 'semantic')),
  content text not null,
  embedding vector(1536),
  importance real not null default 0.5 check (importance between 0 and 1),
  confidence real not null default 0.6 check (confidence between 0 and 1),
  status text not null default 'active'
    check (status in ('active', 'superseded', 'retracted')),
  supersedes uuid references public.memories (id) on delete set null,
  superseded_by uuid references public.memories (id) on delete set null,
  dedupe_key text not null,
  source_thread_id uuid references public.threads (id) on delete set null,
  source_message_id uuid,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Extraction is idempotent on this key: the same statement learned twice
-- updates one row instead of creating a second.
create unique index if not exists memories_dedupe_idx
  on public.memories (workspace_id, assistant_id, dedupe_key);
create index if not exists memories_lookup_idx
  on public.memories (workspace_id, assistant_id, status, occurred_at desc);
create index if not exists memories_embedding_idx
  on public.memories using hnsw (embedding vector_cosine_ops);

create table if not exists public.memory_entities (
  memory_id uuid not null references public.memories (id) on delete cascade,
  entity_id uuid not null references public.entities (id) on delete cascade,
  primary key (memory_id, entity_id)
);

create index if not exists memory_entities_entity_idx
  on public.memory_entities (entity_id);

-- -------------------------------------------------------------- triggers

drop trigger if exists set_entities_updated_at on public.entities;
create trigger set_entities_updated_at before update on public.entities
  for each row execute function public.set_updated_at();
drop trigger if exists set_facts_updated_at on public.facts;
create trigger set_facts_updated_at before update on public.facts
  for each row execute function public.set_updated_at();
drop trigger if exists set_decisions_updated_at on public.decisions;
create trigger set_decisions_updated_at before update on public.decisions
  for each row execute function public.set_updated_at();
drop trigger if exists set_memories_updated_at on public.memories;
create trigger set_memories_updated_at before update on public.memories
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------ RLS

alter table public.entities enable row level security;
alter table public.facts enable row level security;
alter table public.decisions enable row level security;
alter table public.memories enable row level security;
alter table public.memory_entities enable row level security;

drop policy if exists "workspace entities" on public.entities;
create policy "workspace entities" on public.entities
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace facts" on public.facts;
create policy "workspace facts" on public.facts
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace decisions" on public.decisions;
create policy "workspace decisions" on public.decisions
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace memories" on public.memories;
create policy "workspace memories" on public.memories
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "workspace memory links" on public.memory_entities;
create policy "workspace memory links" on public.memory_entities
  for all to authenticated
  using (
    exists (
      select 1 from public.memories m
      where m.id = memory_id and public.is_workspace_member(m.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.memories m
      where m.id = memory_id and public.is_workspace_member(m.workspace_id)
    )
  );

-- --------------------------------------------------------- vector search

-- Semantic search, scoped to one workspace and assistant. SECURITY INVOKER, so
-- row level security still applies to the caller.
create or replace function public.match_memories(
  target_workspace uuid,
  target_assistant uuid,
  query_embedding vector(1536),
  match_limit integer default 8,
  min_similarity real default 0.15
)
returns table (
  id uuid,
  content text,
  kind text,
  importance real,
  confidence real,
  occurred_at timestamptz,
  source_thread_id uuid,
  source_message_id uuid,
  similarity real
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    m.id,
    m.content,
    m.kind,
    m.importance,
    m.confidence,
    m.occurred_at,
    m.source_thread_id,
    m.source_message_id,
    (1 - (m.embedding <=> query_embedding))::real as similarity
  from public.memories m
  where m.workspace_id = target_workspace
    and m.assistant_id = target_assistant
    and m.status = 'active'
    and m.embedding is not null
    and (1 - (m.embedding <=> query_embedding)) >= min_similarity
  order by m.embedding <=> query_embedding
  limit greatest(1, least(match_limit, 50));
$$;

revoke execute on function public.match_memories(uuid, uuid, vector, integer, real) from public, anon;
grant execute on function public.match_memories(uuid, uuid, vector, integer, real) to authenticated;
