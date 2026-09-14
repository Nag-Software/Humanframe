-- Maya chat: samtaler, meldinger (strukturerte parts) og vedlegg-metadata.

create extension if not exists "pgcrypto";

create table if not exists public.maya_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.maya_messages (
  id text primary key,
  conversation_id uuid not null
    references public.maya_conversations (id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant')),
  parts jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  position integer not null,
  created_at timestamptz not null default now()
);

create index if not exists maya_messages_conversation_idx
  on public.maya_messages (conversation_id, position);

create table if not exists public.maya_attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid
    references public.maya_conversations (id) on delete cascade,
  message_id text references public.maya_messages (id) on delete cascade,
  filename text not null,
  media_type text not null,
  size_bytes bigint,
  storage_path text not null,
  url text not null,
  created_at timestamptz not null default now()
);

create index if not exists maya_attachments_conversation_idx
  on public.maya_attachments (conversation_id);

insert into storage.buckets (id, name, public)
values ('maya-attachments', 'maya-attachments', true)
on conflict (id) do nothing;

alter table public.maya_conversations enable row level security;
alter table public.maya_messages enable row level security;
alter table public.maya_attachments enable row level security;

create policy "own conversations" on public.maya_conversations
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "own messages" on public.maya_messages
  for all to authenticated
  using (
    exists (
      select 1 from public.maya_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.maya_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

create policy "own attachments" on public.maya_attachments
  for all to authenticated
  using (
    exists (
      select 1 from public.maya_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.maya_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );
;
