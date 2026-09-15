-- Move pgvector out of the public schema.
--
-- Only one column, one HNSW index and match_memories() depend on it, and the
-- type and operator class follow the extension by OID. The one thing that does
-- not follow is match_memories' pinned search_path: it has to be able to see
-- the `<=>` operator after the move, so the function is recreated with
-- `extensions` on its path.

alter extension vector set schema extensions;

create or replace function public.match_memories(
  target_workspace uuid,
  target_assistant uuid,
  query_embedding extensions.vector(1536),
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
set search_path = public, extensions
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

revoke execute on function public.match_memories(uuid, uuid, extensions.vector, integer, real) from public, anon;
grant execute on function public.match_memories(uuid, uuid, extensions.vector, integer, real) to authenticated;;
