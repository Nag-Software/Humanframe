delete from public.workspaces
where id in (
  select w.id from public.workspaces w
  left join public.workspace_members m on m.workspace_id = w.id
  where m.id is null
);;
