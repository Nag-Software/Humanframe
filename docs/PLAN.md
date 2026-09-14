# Humanframe — arkitektur- og implementeringsplan

Status: forslag, venter godkjenning. Skrevet etter full gjennomgang av kodebasen
og av `eve@0.54.5` og `workflow@4.8.8` (npm + `node_modules/eve/docs/`).

---

## 1. Audit av eksisterende kodebase

### Hva som finnes

**Rammeverk.** Next.js 16.3.5 (App Router, ingen `src/`, alias `@/*`), React
19.2.8, TypeScript strict, Tailwind v4, shadcn (`base-nova`), pnpm 11.
`tsc --noEmit` er grønn i dag. Ingen tester, ingen CI.

**Chat-stacken (fungerer).** AI SDK v7 (`ai@7.0.99`, `@ai-sdk/openai@4`) +
assistant-ui 0.15.19 med `@assistant-ui/ai-sdk`.

- `app/api/assistants/maya/chat/route.ts` — `streamText` → `toUIMessageStream`,
  systemprompt inline, `stopWhen: stepCountIs(6)`, lagrer hele `parts` i `onEnd`.
- `lib/maya/tools.ts` — `createFile`, `showWebsite`, `fetchUrl` (`needsApproval`),
  `draftEmail`, `previewCalendarEvent`, `webSearch` (OpenAI-native).
- `lib/maya/model.ts` — `openai.responses(process.env.MAYA_MODEL ?? "gpt-5.2")`,
  direkte OpenAI-nøkkel, ingen gateway.
- `components/maya/maya-runtime-provider.tsx` — `useChatRuntime` +
  `AssistantChatTransport`, `sendAutomaticallyWhen:
  lastAssistantMessageIsCompleteWithApprovalResponses`.

**UI-laget (største aktivum, ~4 700 linjer).**
`components/assistant-ui/elements/` har allerede thread, tool-fallback,
tool-group, approval-card, sources, reasoning, image, file, web-preview,
web-search, attachments. `components/maya/` har header med voice/video-knapper,
welcome og tool-UI-registrering. Dette skal bevares uendret så langt det går —
det er dette som gir «premium, ikke-teknisk» følelsen vision-dokumentet krever.

**Persistens.** `lib/supabase/server.ts` (service-role, returnerer `null` uten
config), `lib/maya/store.ts` (`maya_conversations`, `maya_messages`,
`maya_attachments`), migrasjon `lib/supabase/migrations/0001_maya_chat.sql`,
public storage-bucket `maya-attachments`.

**Sider/nav.** `/`, `/assistants`, `/assistants/maya`, `/calendar`,
`/routine-tasks`, `/settings/*` — alle unntatt Maya er skjelett (`PageSkeleton`).
Sidebar har hardkodet demo-bruker og team-switcher.

### Konflikter med målarkitekturen

| # | Funn | Konsekvens |
|---|---|---|
| K1 | **Ingen autentisering.** `@supabase/ssr` er installert, men aldri brukt. Ingen middleware, ingen login, `user_id` settes aldri. | Alt går via service role. RLS-policyene i 0001 er skrevet, men omgås fullstendig. Alle samtaler er i praksis delt. Blokkerer alt som heter minne, permissions og multi-tenant. |
| K2 | **eve snakker ikke AI SDK-strøm mot nettleseren.** eve eksponerer NDJSON-eventstrøm + `useEveAgent` (`eve/react`). `data.messages` er `EveMessage[]` som *følger* `UIMessage`-konvensjonen, men dokumentasjonen er eksplisitt: «the types are not interchangeable». `@assistant-ui/ai-sdk`-transporten vil ikke virke mot eve. | Den ene virkelig usikre integrasjonen. Krever en bro (se §4). Bør spikes før fase 2 committes. |
| K3 | **Verktøy er AI SDK-`tool()`, eve krever `defineTool` i `agent/tools/*.ts`.** | Verktøyene må flyttes til `agent/`, Zod-skjemaene kan gjenbrukes 1:1. |
| K4 | **Approval-modellene er ulike.** I dag: `needsApproval` + klientdrevet fortsettelse. eve: `approval: always()` → `input.requested` → `respond()`, durabelt parkert. | `approval-card.tsx` beholdes, wiring byttes. Dagens approval er dessuten kun klientside — serveren stoler på klienten. |
| K5 | **Modellruting.** eve med streng-modell-id går via Vercel AI Gateway (krever OIDC eller `AI_GATEWAY_API_KEY`). I dag brukes `OPENAI_API_KEY` direkte. | Må avklares før fase 2 (åpent spørsmål Q1). |
| K6 | **eve er beta og filsystem-først.** `withEve()` i `next.config.ts` monterer eve som egen Nitro-service i samme Vercel-prosjekt (`/eve/v1/*`), med egen dev-server bak Next-dev. | Bekrefter at `AgentRuntime`-abstraksjonen er nødvendig, og at `agent/` hører hjemme i repo-roten (ikke under `src/`). |
| K7 | **Datamodellen er chat-spesifikk.** `maya_*`-tabellene kjenner ikke bruker, entitet, fakta, mål eller forpliktelse. `maya_messages.id` er `text` (AI SDK-id). | Ny kjernemodell i fase 3; `maya_*` migreres inn i `threads`/`messages` og avvikles. |
| K8 | **Sikkerhetshull som må lukkes før noe deployes.** `upload/route.ts` har ingen auth, ingen størrelses-/typebegrensning ut over 20 MB, klientstyrt sti og *public* bucket. `fetchUrl` henter vilkårlig URL server-side (SSRF) uten allowlist. Ingen rate limiting. | Fase 1 (auth) + fase 8 (hardening). Ikke deploy offentlig før K1 og K8 er lukket. |
| K9 | **Språk.** VISION.md sier «English-first B2B». Kode, prompt og UI er norsk. | Ikke blokkerende, men bør avgjøres nå (Q9) — det påvirker instructions, tabeller og UI-tekst. |
| K10 | Sidebar/dashboard-moduler (Calendar, Routine tasks, Overview) strider mot «ikke bygg dashboard». De er tomme skjeletter. | Behold som navigasjon, ikke bygg ut. Ingen kodeendring nå. |

### Pakker og filer som må endres

**Nye avhengigheter:** `eve` (pin eksakt versjon, beta), `workflow` (kommer via
eve/Vercel), `@vercel/oidc` (hvis OIDC mot gateway), senere `@composio/core`,
`openai` (Realtime/GPT-Live), Tavus-kall gjøres med `fetch`.
**Allerede installert, men ubrukt:** `@supabase/ssr` (tas i bruk i fase 1).

**Filer som endres i fase 1–2:** `next.config.ts`, `app/layout.tsx`,
`lib/supabase/*`, `lib/maya/store.ts`, `app/assistants/maya/page.tsx`,
`components/maya/maya-runtime-provider.tsx`, `app/api/assistants/maya/upload/route.ts`,
`components/nav-user.tsx`, `components/app-sidebar.tsx`.
**Filer som beholdes urørt:** alt under `components/assistant-ui/`,
`components/ui/`, `hooks/`.

### Miljøvariabler

Finnes: `OPENAI_API_KEY`, `MAYA_MODEL`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

Må legges til: `AI_GATEWAY_API_KEY` (eller Vercel OIDC), `APP_URL`,
`EVE_NEXT_PRODUCTION_PORT` (kun lokal prod-build), `COMPOSIO_API_KEY` (fase 5),
`TAVUS_API_KEY` + `TAVUS_PERSONA_ID` + `TAVUS_WEBHOOK_SECRET` (fase 7),
`MAYA_TAVUS_GATEWAY_SECRET` (delt hemmelighet for det OpenAI-kompatible
endepunktet). Alt valideres i `lib/env.ts` (Zod, server/klient delt).

### Risikovurdering

| Risiko | Sannsynlighet | Konsekvens | Håndtering |
|---|---|---|---|
| eve-beta bryter API mellom versjoner | Høy | Middels | Pin eksakt versjon, all bruk bak `AgentRuntime`, les `node_modules/eve/CHANGELOG.md` før hver oppgradering |
| assistant-ui ↔ eve-broen blir dyrere enn antatt (K2) | Middels | Høy | Tidsboks-spike (§6) før fase 2 låses; fallback = behold AI SDK-ruten for chat og bruk eve kun til bakgrunnsarbeid |
| Dobbel sannhet: eve durable history vs Supabase `messages` | Høy hvis uregulert | Høy | Regel: eve eier run-state, Supabase eier forretningsdata. Skriving til Supabase skjer fra eve-hooks, aldri fra klienten |
| Latency i FaceTime: Tavus → vår gateway → durable runtime | Middels | Høy | Egen «lav-latens»-profil i runtime for tale/video (færre steg, ingen sandbox), tung jobb delegeres til bakgrunnsrun |
| Service-role-nøkkel brukt i alle ruter (K1/K8) | Pågår i dag | Høy | Fase 1: bruker-scopet klient som standard, service role kun i eksplisitt navngitte server-funksjoner |
| Vercel-kontoen mangler Workflows/Sandbox-tilgang | Ukjent | Høy | Åpent spørsmål Q2 — verifiser før fase 2 |
| Kostnadsløp (bakgrunnsagenter + heartbeat) | Middels | Middels | Token- og runbudsjett per bruker i fase 8, men logg kostnad fra fase 2 |

---

## 2. Foreslått mappestruktur

Justert til eksisterende repo: **ingen `src/`**, `agent/` i roten (eve krever det),
`lib/` beholdes som i dag, serverlogikk under `server/`.

```
agent/                      # eve, filsystem-først (K6)
  agent.ts  instructions.md
  tools/  skills/  hooks/  channels/eve.ts  schedules/
app/
  (auth)/login, /auth/callback
  api/assistants/maya/{chat,upload}/   # beholdes til broen er verifisert
  api/{approvals,events,tavus,live}/
  assistants/[assistantId]/            # maya blir spesialtilfelle av denne
components/                 # uendret; nye: approvals/, call/, facetime/
server/
  agent/runtime/{agent-runtime.ts,eve-runtime.ts}
  agent/context/{build-context.ts,retrieve-memory.ts}
  agent/memory/{extract-memory.ts,consolidate-memory.ts}
  agent/permissions/permission-engine.ts
  agent/tools/{registry.ts,calendar/,email/}
  agent/channels/{chat-adapter.ts,live-adapter.ts,tavus-adapter.ts}
  db/{queries,repositories,supabase}
  workflows/{heartbeat,commitment-followup,background-task,approval-flow}.ts
lib/                        # rene, delbare hjelpere + env + supabase-klienter
supabase/migrations/        # flyttes hit fra lib/supabase/migrations
```

Grensen som gjelder: **UI importerer aldri `server/`-runtime direkte, og ingenting
utenfor `server/agent/runtime/` importerer `eve`.**

---

## 3. Database- og migrasjonsplan

Migrasjonene flyttes til `supabase/migrations/` og kjøres med Supabase CLI.

- **0002_auth_and_tenancy** — `users` (speiler `auth.users`), `assistants`,
  `user_id NOT NULL` på `maya_*`, trigger for `updated_at`, RLS-policyer som
  faktisk holder, retting av storage-policy (privat bucket + signerte URL-er).
- **0003_core_conversation** — `threads`, `messages` (med `channel`-kolonne:
  `chat | live | facetime`), migrer `maya_conversations`/`maya_messages` inn,
  behold gamle tabeller som views til fase 4.
- **0004_memory** — `entities`, `facts` (type, value, confidence, source_id,
  valid_from/to, superseded_by), `memories` (content, `embedding vector(1536)`,
  importance, source, occurred_at), `memory_entities`, `decisions`.
  `create extension vector`, HNSW-indeks på embedding.
- **0005_goals_commitments** — `goals`, `commitments`, `tasks`, `events`.
- **0006_runs_and_tools** — `agent_runs` (`eve_session_id`, `workflow_run_id`,
  status, kostnad), `tool_calls`, `artifacts`.
- **0007_permissions** — `permissions` (subject, action, level:
  `read|prepare|execute_with_approval|autonomous`), `approvals`.
- **0008_rls_tests** — policy-tester (pgTAP eller integrasjonstest i CI).

Gjennomgående: UUID-PK, `user_id uuid not null references auth.users`,
`created_at`/`updated_at`, RLS på alle brukereide tabeller, `deleted_at` der
sletting skal være sporbar. Ingen `SECURITY DEFINER`-funksjoner uten eksplisitt
grunn. Vektorsøk kjøres gjennom en RPC som selv filtrerer på `auth.uid()`.

---

## 4. Hvordan assistant-ui kobles til eve

Dette er det eneste virkelig uavklarte punktet (K2). eve gir oss:

- HTTP: `POST /eve/v1/session`, `POST /eve/v1/session/:id`,
  `GET /eve/v1/session/:id/stream` (NDJSON), montert same-origin av `withEve()`.
- React: `useEveAgent()` → `{ data.messages, status, events, send, respond,
  resume, cancel, reset }`. HITL kommer som `input.requested` og ligger på
  `part.toolMetadata?.eve?.inputRequest`; svar via `respond()`.

**Anbefalt løsning: `useExternalStoreRuntime` (finnes i assistant-ui 0.15.19).**

```
useEveAgent()  →  EveMessage[]  →  toThreadMessages()  →  useExternalStoreRuntime
      ▲                                                          │
      └────────── send / respond / cancel  ◄─────────────────────┘
```

- `components/maya/eve-runtime-provider.tsx` erstatter
  `maya-runtime-provider.tsx`; `Thread`, tool-UI-ene og approval-kortet rører vi
  ikke.
- `lib/maya/eve-message-adapter.ts` mapper `EveMessage.parts` → assistant-ui-parts
  (text, reasoning, file, dynamic-tool → tool-call). Dette er den koden vi
  faktisk må skrive og teste.
- Approvals: `state: "approval-requested"` → `ApprovalCard` → `respond()`.
- Reload: `useEveAgent({ initialSession: { sessionId, streamIndex: 0 }, resume:
  true })` med `sessionId` fra URL (`/assistants/maya?c=…` erstattes av eve-ens
  `sessionId`).

**Avvist alternativ:** oversette eve-eventer til AI SDK `UIMessageStream` i en
Next-route. Det gir minst endring i frontend, men vi må da reimplementere
resume, HITL-respons og cancel over vår egen route — mer kode i den vanskelige
retningen.

**Fallback hvis spiken feiler:** behold dagens AI SDK-chatrute for chat, og bruk
eve kun til bakgrunnsjobber i fase 4. `AgentRuntime` gjør det byttbart.

**Trådlagring:** `useEveAgent` holder ikke trådlisten. Supabase `threads` eier
listen (`thread_id ↔ eve_session_id`), skrevet fra en eve-hook. assistant-ui
Cloud brukes ikke.

---

## 5. AgentRuntime-abstraksjonen

`server/agent/runtime/agent-runtime.ts` — ingen eve-typer lekker ut:

```ts
export type RuntimeChannel = "chat" | "live" | "facetime" | "system";

export type RuntimeSession = {
  sessionId: string;          // eve sessionId
  threadId: string;           // Supabase threads.id
  userId: string;
  assistantId: string;
  channel: RuntimeChannel;
};

export type RuntimeEvent =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.call"; callId: string; name: string; input: unknown }
  | { type: "tool.result"; callId: string; output: unknown }
  | { type: "approval.requested"; requestId: string; callId: string;
      toolName: string; input: unknown; risk: RiskLevel }
  | { type: "run.status"; status: "started" | "waiting" | "completed" | "failed"
      | "cancelled"; error?: { code: string; message: string } };

export type ApprovalDecision =
  | { decision: "approve"; scope?: "once" | "always" }
  | { decision: "deny"; reason?: string };

export interface AgentRuntime {
  startSession(input: {
    userId: string; assistantId: string; channel: RuntimeChannel;
    threadId?: string; message?: RuntimeInput; context?: ContextPackage;
  }): Promise<RuntimeSession>;

  continueSession(input: {
    sessionId: string; message: RuntimeInput;
    turnPolicy?: "queue" | "steer";
  }): Promise<{ runId: string }>;

  streamRun(input: { sessionId: string; fromIndex?: number; signal?: AbortSignal })
    : AsyncIterable<RuntimeEvent>;

  cancelRun(input: { sessionId: string }): Promise<void>;
  resumeRun(input: { sessionId: string }): Promise<RuntimeSession>;

  submitApproval(input: { sessionId: string; requestId: string;
    decision: ApprovalDecision; actorUserId: string }): Promise<void>;

  handleExternalEvent(input: { userId: string; assistantId: string;
    event: ExternalEvent }): Promise<{ sessionId: string }>;   // frister, webhooks, heartbeat
}
```

`server/agent/runtime/eve-runtime.ts` er eneste implementasjon og eneste fil som
importerer `eve` / `eve/client`. Kanaladaptere, minne, permissions og frontend
snakker bare med interfacet. Frontend bruker `useEveAgent` direkte for chat —
men gjennom vår egen provider-komponent, slik at bytte av runtime betyr én ny
provider, ikke ny UI.

---

## 6. Hva som trygt kan implementeres først

Rekkefølge etter risiko, lavest først. Punkt 1–3 er verdifulle uansett hva som
skjer med eve.

1. **Env-validering + Supabase-klienter (`@supabase/ssr`)** — ingen
   arkitekturbinding, fjerner «null-hvis-ukonfigurert»-fellen.
2. **Auth: login, middleware, `user_id` på alle rader, ekte RLS, privat bucket,
   sikret upload-rute** — lukker K1 og halve K8. Kan gjøres uten å røre chatten.
3. **Trådliste i Supabase** (`threads` med `eve_session_id`-kolonne klar, men
   ubrukt) — chatten fortsetter å virke på AI SDK.
4. **Spike (tidsboks 1 dag): eve i en egen route + `useEveAgent` bak et
   feature-flagg**, kun for å bevise broen i §4. Ingen migrering av verktøy før
   spiken er grønn.
5. Deretter fase 2 i full bredde.

Det som **ikke** bør røres nå: assistant-ui-elementene, designet, dashboard-sidene.

---

## 7. Avklarte valg og gjenstående spørsmål

### Låst (besluttet 14.09.2026)

1. **AI Gateway** – Vercel OIDC i preview og production. Ingen permanent
   gateway-/OpenAI-nøkkel lagret der. Lokalt brukes Vercels lokale auth-flyt,
   med `AI_GATEWAY_API_KEY` som fallback.
2. **Workflows** – påkrevd for MVP, brukes av eve til durable runs, pause/resume
   og retries. **Sandbox utsettes**; Maya kjører ikke vilkårlig kode i MVP.
3. **Tenancy** – én bruker og én Maya per personlig workspace, men databasen er
   workspace-basert fra 0002: `workspaces`, `workspace_members`,
   `assistants.workspace_id`, `workspace_id` på alle tenant-eide tabeller, RLS
   på medlemskap (ikke `user_id`), og personlig workspace opprettes automatisk
   ved registrering med brukeren som `owner`.
4. **Run-state** – eve eier agentens run-state; Supabase oppdateres gjennom
   idempotente eve-hooks. `agent_runs` er kun en lesbar projeksjon med status og
   referanse til eve-/workflow-ID, aldri en kopi av Vercels event-logg. Hooks
   bruker stabile event-ID-er og idempotente upserts. Supabase gjenopptar aldri
   en eve-run på egen hånd.
5. **Språk** – engelsk i kode, databasenavn, typer, interne prompts og teknisk
   dokumentasjon. Norsk kan være første UI-språk, men all synlig tekst går
   gjennom i18n-laget (`lib/i18n/`). `VISION.md` fortsetter på engelsk.

### Preflight: Vercel Workflows

Kontoen `denektetruls' projects` er på **Hobby**. Workflows er tilgjengelig der:
50 000 workflow-events og 1 GB skrevet data inkludert per måned, og ingen
plan-sperre for eve. To forbehold før produksjon:

- **Workflow Data Retained er ikke tilgjengelig på Hobby**, og lagring beholdes
  bare **1 døgn etter at en run er fullført** (Pro: 7 døgn, Enterprise: 30).
- Rate limit 100 000 requests/min på Hobby er rikelig; grensen som betyr noe er
  25 000 events og 10 000 steg per run.

Konsekvens: Hobby holder for utvikling og for å bevise fase 2 og 4. Gå til Pro
før ekte bruk — særlig fordi Maya skal kunne parkere en run i dagevis mens den
venter på en approval eller en fredagsfrist. Det er også det ene punktet
dokumentasjonen ikke svarer entydig på: en run som *venter* er ikke fullført, så
retensjonsgrensen skal ikke ramme den, men dette bør verifiseres empirisk med en
lang `sleep` i fase 4 før vi stoler på det i produksjon.

Humanframe har foreløpig **ikke** et Vercel-prosjekt; det opprettes ved første
deploy i fase 2.

### Gjenstår (blokkerer ikke fundamentet)

- **Composio**: konto og valg mellom managed auth og egne Google OAuth-apper
  (fase 5).
- **GPT-Live**: Realtime-tilgang, og om vi godtar latensen ved å delegere
  verktøykall til Maya-runtime (fase 6).
- **Tavus**: konto, persona og bekreftelse av formatkravet til custom-LLM-
  endepunktet (fase 7).
- **Google OAuth** må aktiveres i Supabase Auth (client ID/secret) før
  «Continue with Google» virker. Magic link krever konfigurert SMTP; Supabase
  sin innebygde avsender har lav rate limit.

## 8. Fil-for-fil-plan

### Fase 1 — Foundation

| Fil | Handling |
|---|---|
| `lib/env.ts` | Ny. Zod-validering av server- og klientvariabler, kastes ved oppstart. |
| `lib/supabase/client.ts` | Ny. Browser-klient (`createBrowserClient`). |
| `lib/supabase/server.ts` | Endres. `createServerClient` med cookies som standard; `getSupabaseAdmin()` beholdes, men navngis `getServiceRoleClient()` og brukes kun i navngitte moduler. |
| `lib/supabase/middleware.ts` | Ny. Sesjonsfornyelse. |
| `middleware.ts` | Ny. Beskytter `/`, `/assistants/*`, `/settings/*`; slipper `/login`, `/auth/*`. |
| `app/(auth)/login/page.tsx` | Ny. E-post + magic link / OAuth, i eksisterende designspråk. |
| `app/auth/callback/route.ts` | Ny. Kodeveksling. |
| `app/layout.tsx` | Endres. Henter bruker server-side, sender til sidebar. |
| `components/nav-user.tsx`, `components/app-sidebar.tsx` | Endres. Ekte bruker i stedet for demo-data, logg ut. |
| `supabase/migrations/0002_auth_and_tenancy.sql` | Ny. `users`, `assistants`, `user_id` på `maya_*`, RLS som holder, privat bucket + policy. |
| `lib/supabase/migrations/0001_maya_chat.sql` | Flyttes til `supabase/migrations/`. |
| `lib/maya/store.ts` | Endres. Tar `userId`, bruker bruker-scopet klient, skriver `user_id`. |
| `app/api/assistants/maya/upload/route.ts` | Endres. Krever innlogging, serverstyrt sti, privat bucket + signert URL, MIME-allowlist. |
| `app/assistants/maya/page.tsx` | Endres. Krever bruker, laster tråd via `user_id`. |
| `lib/maya/model.ts` | Endres. Leser fra `lib/env.ts`; forberedt for gateway. |
| `lib/logger.ts` | Ny. Strukturert logging (`requestId`, `userId`, `threadId`). |

**Resultat fase 1:** innlogging virker, `/assistants/maya` er beskyttet, alle
rader er eid av en bruker, RLS testet manuelt med to kontoer. `tsc`, `lint` og
`build` grønne.

### Fase 2 — Maya runtime

| Fil | Handling |
|---|---|
| *(spike)* `docs/spike-eve-assistant-ui.md` | Ny. Resultat av broen i §4 før resten committes. |
| `package.json` | Endres. `eve` pinnet eksakt. |
| `next.config.ts` | Endres. `withEve(nextConfig)`. |
| `agent/agent.ts` | Ny. `defineAgent({ model, limits, compaction })`. |
| `agent/instructions.md` | Ny. Mayas identitet — flyttes fra `SYSTEM_PROMPT` i chat-routen. |
| `agent/channels/eve.ts` | Ny. `AuthFn` som verifiserer Supabase-sesjonen (cookie, same-origin). Fail-closed. |
| `agent/tools/{create_file,show_website,fetch_url,draft_email,preview_calendar_event}.ts` | Nye. `defineTool` med Zod-skjemaene fra `lib/maya/tools.ts`; `fetch_url` får `approval: always()` og URL-allowlist. |
| `agent/hooks/persist-turn.ts` | Ny. Skriver `threads`/`messages`/`agent_runs`/`tool_calls` til Supabase ved `message.completed` og `turn.completed`. |
| `server/agent/runtime/agent-runtime.ts` | Ny. Interfacet i §5. |
| `server/agent/runtime/eve-runtime.ts` | Ny. Eneste `eve`-import på serversiden. |
| `server/db/repositories/threads.ts` | Ny. `thread_id ↔ eve_session_id`. |
| `supabase/migrations/0003_core_conversation.sql` | Ny. `threads`, `messages`, migrering fra `maya_*`. |
| `components/maya/eve-runtime-provider.tsx` | Ny. `useEveAgent` + `useExternalStoreRuntime`. |
| `lib/maya/eve-message-adapter.ts` | Ny. `EveMessage` → assistant-ui-parts, inkl. HITL. |
| `components/maya/maya-chat.tsx` | Endres. Bytter provider (flagg-styrt i overgangen). |
| `app/assistants/maya/page.tsx` | Endres. `sessionId` fra URL, `resume: true`. |
| `app/api/assistants/maya/chat/route.ts` | Beholdes bak flagg til broen er verifisert, deretter slettes. |
| `lib/maya/tools.ts`, `lib/maya/model.ts` | Slettes når verktøyene er flyttet til `agent/tools/`. |

**Resultat fase 2:** Maya streamer gjennom eve i assistant-ui, samtalen overlever
refresh via durable session, approval-kortet parkerer og gjenopptar kjøringen
server-side. `tsc`, `lint`, `build` og en manuell røyktest kjøres før fase 3.

---

## 9. Status: fase 1 er levert

Implementert og verifisert 14.09.2026. `tsc --noEmit`, `eslint` (0 errors) og
`next build` er grønne.

**Autentisering og tenancy**

- `proxy.ts` (Next 16 har omdøpt `middleware.ts` → `proxy.ts`) fornyer
  Supabase-sesjonen og sender uinnlogget trafikk til `/login`.
- `lib/supabase/{client,server,proxy}.ts`: bruker-scopet klient er standard;
  service role ligger bak `getServiceRoleClient()` og brukes ikke av noen rute i
  fase 1.
- App-sidene er flyttet til rutegruppen `app/(app)/` med egen layout som krever
  sesjon; `app/layout.tsx` er nå bare skallet. `/login` ligger i `app/(auth)/`.
- `server/db/request-scope.ts` løser bruker + workspace én gang per request.

**Login-siden** (shadcn `login-02` som utgangspunkt)

- Venstre: logo, «Continue with Google» (Supabase OAuth) og magic link.
  Ingen passord, ingen Apple-login.
- Høyre: `components/auth/auth-visual.tsx` — nesten sort flate, tre svært
  langsomme organiske former (96–142 s), vignett for dybde, invertert
  Humanframe-symbol som puster (18 s) og en myk lysrefleksjon som sveiper over
  symbolet, maskert til symbolets silhuett. Respekterer `prefers-reduced-motion`
  via `useReducedMotion`. `components/auth/auth-visual-panel.tsx` gater
  `next/dynamic` bak `(min-width: 1024px)`; verifisert i produksjonsbygg at
  mobilklienten ikke laster motion-chunken.
- All synlig tekst går gjennom `lib/i18n/`.

**Database** (migrasjonene ligger i `supabase/migrations/`, kjørt mot dev)

- `0001` chat-tabellene, `0002` workspaces/medlemskap/assistants + `workspace_id`
  og medlemskaps-RLS på alle chat-tabeller + privat storage-bucket,
  `0003` idempotent `provision_user()` / `ensure_user_bootstrap()`,
  `0004` least privilege på funksjonene.
- Verifisert med to testbrukere: signup-trigger oppretter workspace, `owner`-
  medlemskap og Maya; bruker B ser ikke bruker A sine samtaler; forsøk på å
  skrive inn i A sitt workspace avvises av RLS; anonym lesing gir tomt svar;
  opplasting til et annet workspace sin prefix avvises; bøtta er ikke lenger
  offentlig. Testbrukerne og testdataene er slettet etterpå.
- `ensure_user_bootstrap()` kalles i `/auth/callback` og er idempotent (to kall
  gir samme workspace, fortsatt ett workspace).

**Sikkerhet lukket i denne fasen**

- Upload-ruten krever sesjon, har MIME-allowlist, serverstyrt sti med
  `workspace_id` som første segment, privat bøtte og signert URL.
- Chat-ruten krever sesjon og «claimer» samtalen før modellkall, slik at RLS
  avviser en samtale fra et annet workspace før tokens brukes.

**Gjenstår i fase 1-sporet**

- Resterende norsk UI-tekst i `components/maya/*` og dashboard-skjelettene er
  ikke flyttet til i18n-laget ennå.
- Signerte vedlegg-URL-er varer 30 dager; den autoriserte re-signerings-ruten er
  utsatt til fase 8 (markert med TODO i koden).
- Google OAuth og SMTP må konfigureres i Supabase før de to innloggingsveiene
  faktisk virker ende-til-ende.

---

## 10. Status: datamodell + fase 2 (pågår)

**Datamodell (0005, kjørt mot dev).** `maya_*` er omdøpt til
`threads`/`messages`/`attachments` etter forslaget i `docs/DATA-MODEL.md`, med
`agent_runs` og `tool_calls` som lesbar projeksjon. Verifisert mot databasen:
idempotent upsert på `(thread_id, source_message_id, created_at)` (samme batch
to ganger gir fortsatt 5 rader), og keyset-paginering med markør gir riktige
sider. Én korreksjon underveis: den unike indeksen kunne ikke være partiell,
fordi PostgREST ikke kan bruke en partiell indeks som `ON CONFLICT`-mål.

**eve er montert.** `withEve()` i `next.config.ts`, agenten i `agent/`
(instructions, sju verktøy, `defaultTools: false` siden MVP ikke har sandbox),
og `agent/channels/eve.ts` som verifiserer Supabase-sesjonen fra cookien.
`GET /eve/v1/health` svarer `{"ok":true,"status":"ready"}` fra Next-dev-serveren,
og `POST /eve/v1/session` oppretter en durable session.

**Broen til assistant-ui er skrevet.** `lib/maya/eve-message-adapter.ts` mapper
`EveMessage`-parts til `ThreadMessageLike` (tekst, reasoning, filer, tool calls
og approval-tilstandene), og `components/maya/eve-runtime-provider.tsx` kobler
`useEveAgent` til `useExternalStoreRuntime`. Kanalen velges med
`NEXT_PUBLIC_MAYA_RUNTIME` (`ai-sdk` som standard, `eve` for den nye veien), så
begge kjører side om side til eve er bevist.

**Blokkering:** modellkallet feiler med `AI Gateway received no credentials`.
Det er forventet — kontoen har ingen Humanframe-prosjekt på Vercel ennå. Kjør
`eve link` (populerer `VERCEL_OIDC_TOKEN` lokalt) eller sett
`AI_GATEWAY_API_KEY`. Begge deler er kontoendringer, så de venter på deg.

**Gjenstår i fase 2 etter det:** `agent/hooks/persist-turn.ts` som skriver
`messages`, `agent_runs` og `tool_calls` fra eve-hooks med `meta.at` som
`created_at`, og en røyktest av streaming + approval-kortet ende-til-ende.
