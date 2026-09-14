alter table public.tool_calls
  add column if not exists eve_session_id text;

update public.tool_calls tc
set eve_session_id = r.eve_session_id
from public.agent_runs r
where tc.run_id = r.id and tc.eve_session_id is null;

delete from public.tool_calls a
using public.tool_calls b
where a.eve_session_id = b.eve_session_id
  and a.call_id = b.call_id
  and a.started_at < b.started_at;

delete from public.tool_calls where eve_session_id is null;

alter table public.tool_calls alter column eve_session_id set not null;

alter table public.tool_calls drop constraint if exists tool_calls_run_id_call_id_key;
alter table public.tool_calls
  add constraint tool_calls_session_call_key unique (eve_session_id, call_id);

create index if not exists tool_calls_session_idx
  on public.tool_calls (eve_session_id, started_at desc);;
