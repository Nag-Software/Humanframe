-- Connecting a mailbox is the owner's grant to Maya. The register still
-- seeded every email action as disabled, so a grant of send discovered
-- nothing. Turn the shipped Gmail and Outlook actions on. Versions already
-- pinned in an environment are left alone.

update public.connector_actions
set enabled = true
where action_key in ('email.search', 'email.read', 'email.send')
  and provider in ('gmail', 'outlook');

-- Existing Maya grants were often read-only. Connecting now writes
-- [read, send]; bring live rows in line without waiting for a reconnect.
-- Send still requires in-thread approval.

with stale as (
  select g.id, g.workspace_id, g.account_id, g.assistant_id, g.granted_by
    from public.connector_grants g
    join public.assistants a on a.id = g.assistant_id
   where a.slug = 'maya'
     and g.revoked_at is null
     and not (g.capabilities @> array['read', 'send']::text[])
),
revoked as (
  update public.connector_grants g
     set revoked_at = now()
    from stale
   where g.id = stale.id
  returning stale.workspace_id, stale.account_id, stale.assistant_id, stale.granted_by
)
insert into public.connector_grants (
  workspace_id, account_id, assistant_id, capabilities, granted_by
)
select workspace_id, account_id, assistant_id, array['read', 'send']::text[], granted_by
  from revoked;

-- Active mailboxes that never received a Maya grant at all.

insert into public.connector_grants (
  workspace_id, account_id, assistant_id, capabilities, granted_by
)
select acc.workspace_id,
       acc.id,
       ast.id,
       array['read', 'send']::text[],
       acc.user_id
  from public.connector_accounts acc
  join public.assistants ast
    on ast.workspace_id = acc.workspace_id
   and ast.slug = 'maya'
 where acc.status = 'active'
   and not exists (
     select 1
       from public.connector_grants g
      where g.account_id = acc.id
        and g.assistant_id = ast.id
        and g.revoked_at is null
   );
