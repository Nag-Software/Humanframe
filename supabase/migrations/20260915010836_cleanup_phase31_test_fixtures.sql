delete from public.assistants a
where a.slug <> 'maya'
  and not exists (
    select 1 from public.workspace_members m where m.workspace_id = a.workspace_id
  );

delete from public.workspaces
where id in (
  select w.id from public.workspaces w
  left join public.workspace_members m on m.workspace_id = w.id
  where m.id is null
);;
