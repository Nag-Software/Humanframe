-- ---------------------------------------------------------------------------
-- Make the connected-account index usable as an ON CONFLICT target.
--
-- It was created partial (`where connected_account_id is not null`), which
-- Postgres cannot infer from a bare column list — so every upsert failed with
-- 42P10 and no account could ever be bound.
--
-- Dropping the predicate changes nothing about what the index permits. Postgres
-- treats NULLs as distinct in a unique index by default, so rows still awaiting
-- a provider id (connected_account_id IS NULL) never conflict with each other,
-- exactly as the partial form intended. The only difference is that the index
-- can now be named as a conflict target.
-- ---------------------------------------------------------------------------

drop index if exists public.connector_accounts_connected_idx;

create unique index if not exists connector_accounts_connected_idx
  on public.connector_accounts (workspace_id, provider, connected_account_id);
