-- Maya names her own conversations, and the shell rate-limits its writes.

-- Who named the thread. A user's first message is a placeholder title; hers
-- replaces it once and is never overwritten by a later run.
alter table public.threads
  add column if not exists title_source text not null default 'user'
    check (title_source in ('user', 'assistant'));

-- Fixed-window rate limiting, keyed on the signed-in principal. The function
-- reads `auth.uid()` itself so a caller can only ever spend its own budget,
-- and the table has no policies: nothing reads it but the function.
create table if not exists public.rate_limits (
  principal uuid not null,
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (principal, bucket)
);

alter table public.rate_limits enable row level security;

create or replace function public.take_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_principal uuid := auth.uid();
  v_now timestamptz := now();
  v_count integer;
begin
  if v_principal is null then
    return false;
  end if;

  insert into public.rate_limits (principal, bucket, window_start, count)
  values (v_principal, p_bucket, v_now, 1)
  on conflict (principal, bucket) do update
    set count = case
          when public.rate_limits.window_start
               + make_interval(secs => p_window_seconds) <= v_now
          then 1
          else public.rate_limits.count + 1
        end,
        window_start = case
          when public.rate_limits.window_start
               + make_interval(secs => p_window_seconds) <= v_now
          then v_now
          else public.rate_limits.window_start
        end
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke execute on function public.take_rate_limit(text, integer, integer)
  from public, anon;
grant execute on function public.take_rate_limit(text, integer, integer)
  to authenticated;
