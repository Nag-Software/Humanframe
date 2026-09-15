-- A tenant-safe, deterministic identity for entities.
--
-- The 0006 index was an expression index on lower(name), which PostgREST
-- cannot use as an ON CONFLICT target. A stored generated column gives the same
-- normalisation a real constraint can point at, and the writer normalises the
-- same way: lowercase, collapsed whitespace, trimmed. No fuzzy matching and no
-- automatic merging — two spellings stay two entities until we decide
-- otherwise.

alter table public.entities
  add column if not exists normalized_name text
    generated always as (lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))) stored;

drop index if exists public.entities_identity_idx;

alter table public.entities
  drop constraint if exists entities_identity_key;
alter table public.entities
  add constraint entities_identity_key
    unique (workspace_id, assistant_id, kind, normalized_name);;
