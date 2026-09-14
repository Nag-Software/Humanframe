# Datamodell — forslag til migrasjon 0005

Status: **forslag, ikke implementert.** Skrevet etter gjennomgang av
`supabase/migrations/0001`–`0004` (alle kjørt mot dev) og av repositoriene i
`server/db/`.

## 1. Hva som allerede finnes

| Tabell | Status i dag | Rader |
|---|---|---|
| `users`, `workspaces`, `workspace_members`, `assistants` | 0002. Fungerer, RLS på medlemskap. | 1 / 1 / 1 / 1 |
| `maya_conversations` | Har `workspace_id`, `assistant_id`, `created_by`. | 0 |
| `maya_messages` | `id text` (AI SDK-id), `parts jsonb`, `position int`. | 0 |
| `maya_attachments` | `storage_path`, `url`, `workspace_id`. | 0 |

To ting er verdt å slå fast:

- **`assistants` er allerede flerassistent-klar.** Den er workspace-eid med
  `unique (workspace_id, slug)`. Det eneste som begrenser oss til én Maya er
  `provision_user()` i 0003, som setter inn nøyaktig én rad — altså
  applikasjonslogikk, slik kravet sier.
- **Chat-tabellene er tomme.** Vi kan derfor endre dem i stedet for å lage nye
  ved siden av. Forslaget bruker `alter table … rename to …`, ikke nye
  parallelltabeller.

## 2. Foreslåtte endringer

### 2.1 `maya_conversations` → `threads`

```sql
alter table public.maya_conversations rename to threads;

alter table public.threads
  add column channel text not null default 'chat'
    check (channel in ('chat', 'live', 'facetime', 'system')),
  add column status text not null default 'active'
    check (status in ('active', 'archived')),
  add column eve_session_id text,          -- koblingen til eve sin durable session
  add column last_message_at timestamptz not null default now(),
  alter column assistant_id set not null;

create unique index threads_eve_session_idx
  on public.threads (eve_session_id) where eve_session_id is not null;
create index threads_workspace_recent_idx
  on public.threads (workspace_id, last_message_at desc, id desc);
create index threads_assistant_recent_idx
  on public.threads (assistant_id, last_message_at desc, id desc);
```

`eve_session_id` er den eneste kolonnen som peker inn i eve. Vi speiler ikke
turns, steg eller events — det eier eve.

### 2.2 `maya_messages` → `messages`

Én felles tabell for alle assistenter, alle brukere og alle kanaler.

```sql
alter table public.maya_messages rename to messages;

-- id: fra AI SDK-tekststreng til uuid, og primærnøkkel som tåler partisjonering
alter table public.messages
  drop constraint maya_messages_pkey,
  alter column id type uuid using gen_random_uuid(),
  alter column id set default gen_random_uuid(),
  add primary key (id, created_at);

alter table public.messages
  rename column conversation_id to thread_id;
alter table public.messages
  rename column parts to content;

alter table public.messages
  add column assistant_id uuid not null references public.assistants (id) on delete cascade,
  add column channel text not null default 'chat'
    check (channel in ('chat', 'live', 'facetime', 'system')),
  add column source_message_id text,   -- eve/AI SDK sin egen id
  add column eve_session_id text,
  add column eve_turn_id text,
  drop column position;

alter table public.messages
  drop constraint messages_role_check,
  add constraint messages_role_check
    check (role in ('system', 'user', 'assistant', 'tool'));
```

**Indeksene kravet ber om, eksakt:**

```sql
create index messages_thread_cursor_idx
  on public.messages (thread_id, created_at desc, id desc);
create index messages_workspace_recent_idx
  on public.messages (workspace_id, created_at desc);
create index messages_assistant_recent_idx
  on public.messages (assistant_id, created_at desc);
```

**Idempotens for eve-hooks:**

```sql
create unique index messages_source_idx
  on public.messages (thread_id, source_message_id, created_at)
  where source_message_id is not null;
```

To designvalg som henger sammen og er verdt å lese nøye:

1. **Primærnøkkelen er `(id, created_at)`.** Postgres krever at
   partisjonsnøkkelen inngår i enhver unik constraint. Gjør vi dette nå, er
   `partition by range (created_at)` senere en ren datamigrering uten å måtte
   bygge om nøkler og fremmednøkler.
2. **`created_at` settes fra eve sitt event-tidsstempel (`meta.at`), ikke fra
   `now()`.** eve minter `meta.id` og `meta.at` én gang og gjentar dem ved
   replay. Når hooken skriver med samme `(thread_id, source_message_id,
   created_at)`, blir en retry en no-op i stedet for en duplikatrad. Dette er
   selve mekanismen som gjør «idempotente eve-hooks» sann, og den forutsetter at
   vi ikke lar databasen sette tidsstempelet.

**Innhold:** `content jsonb` holder parts-arrayet — tekst, bilder, filer,
tool calls, sources, reasoning og generativ UI. Filer ligger i Supabase Storage;
`content` inneholder bare referanse (attachment-id og media-type), aldri base64.
Vi legger på en constraint som fanger feilbruk tidlig:

```sql
alter table public.messages
  add constraint messages_content_is_array check (jsonb_typeof(content) = 'array'),
  add constraint messages_content_size check (pg_column_size(content) < 1000000);
```

**Ingen embeddings på råmeldinger.** Ingen trigger, ingen kolonne, ingen jobb
rører `messages`. Bare konsoliderte minner får vektorer (§2.5).

### 2.3 `maya_attachments` → `attachments`

```sql
alter table public.maya_attachments rename to attachments;
alter table public.attachments rename column conversation_id to thread_id;

alter table public.attachments
  drop constraint maya_attachments_message_id_fkey,
  alter column message_id type uuid using null,   -- sporing, ikke fremmednøkkel
  add column checksum text,
  drop column url;                                 -- signeres ved behov
```

Fremmednøkkelen fra vedlegg til melding fjernes med vilje: en fremmednøkkel inn
i en partisjonert tabell må inkludere partisjonsnøkkelen, og den ville blitt en
blokkering den dagen `messages` partisjoneres. Retningen snus — meldingens
`content` refererer vedlegget.

`url` fjernes fordi en lagret signert URL utløper. Stien er fasiten, og URL-en
signeres når den skal brukes. Dette rydder også opp i TODO-en fra fase 1.

Sti-format (uendret prinsipp, workspace først, som storage-policyen krever):
`<workspace_id>/<thread_id>/<uuid>-<filnavn>`.

### 2.4 Projeksjon av agent-runs

Lesbar projeksjon, ikke en kopi av Vercels event-logg:

```sql
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assistant_id uuid not null references public.assistants (id) on delete cascade,
  thread_id uuid references public.threads (id) on delete set null,
  eve_session_id text not null,
  eve_turn_id text not null,
  workflow_run_id text,
  status text not null check (status in
    ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  error jsonb,
  input_tokens bigint, output_tokens bigint, cost_usd numeric(12, 6),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (eve_session_id, eve_turn_id)
);

create table public.tool_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid references public.agent_runs (id) on delete cascade,
  thread_id uuid references public.threads (id) on delete set null,
  call_id text not null,
  tool_name text not null,
  input jsonb, output jsonb,
  status text not null check (status in
    ('requested', 'awaiting_approval', 'running', 'succeeded', 'failed', 'denied')),
  risk text not null default 'read'
    check (risk in ('read', 'prepare', 'execute_with_approval', 'autonomous')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (run_id, call_id)
);
```

`unique (eve_session_id, eve_turn_id)` og `unique (run_id, call_id)` er det som
lar hooks kjøre `on conflict … do update` uten å skape duplikater ved retry.

### 2.5 Minne (skisse, implementeres i fase 3)

Tas ikke med i 0005 utover `create extension vector`, men formen låses nå:

- `entities`, `facts`, `decisions`: strukturert minne, ingen vektorer.
- `memories`: **kun konsoliderte langtidsminner** — `content text`,
  `embedding vector(1536)`, `importance`, `source` (hvilken tråd/melding det kom
  fra), `occurred_at`, `superseded_by`, HNSW-indeks på `embedding`.
- Konsolideringsjobben leser `messages`, skriver `memories`. Aldri motsatt vei,
  og aldri automatisk per melding.

### 2.6 RLS

Alle nye og omdøpte tabeller får samme mønster som i 0002 — ingen ny
mekanisme:

```sql
create policy "workspace agent_runs" on public.agent_runs
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
```

Omdøping beholder eksisterende policyer, men de får nye navn for å matche
tabellene.

## 3. Cursor pagination

Ingen `OFFSET`. Keyset på samme kolonner som indeksen:

```sql
-- første side
select id, role, content, metadata, created_at
from public.messages
where thread_id = $1
order by created_at desc, id desc
limit $2;

-- neste side, med markøren fra siste rad
select id, role, content, metadata, created_at
from public.messages
where thread_id = $1
  and (created_at, id) < ($2::timestamptz, $3::uuid)
order by created_at desc, id desc
limit $4;
```

Markøren eksponeres som en opak base64-streng (`<created_at>|<id>`) fra
repositoriet, slik at UI-et aldri konstruerer den selv. Tråden rendres i
stigende rekkefølge; vi henter nyeste side først og reverserer i minnet.

## 4. Kodeendringer som følger

| Fil | Endring |
|---|---|
| `server/db/repositories/conversations.ts` | Splittes i `threads.ts` og `messages.ts`. `listMessages({ threadId, cursor, limit })` erstatter `loadMessages`. |
| `server/db/repositories/assistants.ts` | `getAssistantBySlug` beholdes; `listAssistants(workspaceId)` legges til. |
| `app/api/assistants/maya/chat/route.ts` | Skriver `thread_id`, `assistant_id`, `channel`, `source_message_id`. |
| `app/api/assistants/maya/upload/route.ts` | Sti med `thread_id`, lagrer ikke `url`, returnerer signert URL uten å persistere den. |
| `app/(app)/assistants/maya/page.tsx` | Laster første side via cursor i stedet for hele tråden. |
| `agent/hooks/persist-turn.ts` (fase 2) | Skriver `messages`, `agent_runs`, `tool_calls` idempotent med eve sine event-ider og `meta.at`. |

## 5. Spørsmål før implementering

1. **`messages.assistant_id` som `not null`?** Det gjør alle brukermeldinger
   knyttet til assistenten de ble sendt til, og gjør indeksen
   `(assistant_id, created_at desc)` komplett. Alternativet er nullable for
   system-/importmeldinger. Forslag: `not null`.
2. **Beholder vi `maya_`-navnene som views** for bakoverkompatibilitet? Ingen
   data finnes, og ingen ekstern konsument. Forslag: nei, rent kutt.
3. **`channel` som `text` + check, eller Postgres-enum?** Enum er strammere,
   men krever migrasjon for hver ny kanal. Forslag: `text` + check.
4. **Beholdningstid på `messages`.** Partisjonering gir mening først når vi vet
   om vi arkiverer eller sletter gamle meldinger. Ingen beslutning nødvendig nå,
   men skjemaet er klart for begge.
