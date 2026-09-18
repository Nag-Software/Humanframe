# Gaps — vision versus the code

Status: written 2026-09-17 against branch `facetime` at `7ea310b`, after a
full pass over the code, `tsc`, `next build` and every deterministic suite
(292 checks green). The reference is [`VISION.md`](VISION.md); the plans in
[`PLAN.md`](PLAN.md), [`PHASE-4.md`](PHASE-4.md) and [`PHASE-5.md`](PHASE-5.md)
say how each area was meant to land.

Severity, as used below:

- **blocking** — the MVP is not the MVP without it;
- **should** — the vision names it explicitly and it is missing or partial;
- **later** — a known, deliberate deferral. Listed so it is not forgotten.

Each row says what the vision asks for, what the code does today, and the
smallest change that closes the gap. Nothing here is a redesign.

---

## 1. The three experiences

| # | Vision | Today | Gap | Severity |
|---|---|---|---|---|
| 1.1 | Chat with Maya | eve runtime, durable session, streamed parts, approvals, attachments, dictation | — | done |
| 1.2 | Voice call | OpenAI Live over WebRTC; tool work delegated to eve so a call reaches every tool. 20/day, 1 concurrent, 15 min. | Approvals cannot be answered out loud; Maya says "finish it in chat". Acceptable for MVP, but the hand-off is prose only — there is no card waiting in the thread when the call ends. | should |
| 1.3 | Face-to-face video | Tavus echo PAL lip-syncing OpenAI Live audio. Works. | **Prototype, not the product.** No perception (Maya cannot see the user, and is told to deny it), and the overlay renders a debug panel of nine latency metrics — exactly the "technical machinery" the vision forbids. `components/maya/facetime/facetime-overlay.tsx:98-111`. | blocking |
| 1.4 | FaceTime-style controls that disappear when inactive | Call and video overlays show static controls; nothing fades on inactivity. | Idle-fade on the call and video surfaces. Small. | should |
| 1.5 | One person across channels | Same instructions, same `buildContextPackage`, same thread, same memory extraction on every channel. | — | done |

## 2. Maya's capabilities

| # | Vision | Today | Gap | Severity |
|---|---|---|---|---|
| 2.1 | Streamed text, speech, **voice messages**, video | Text, live speech, video. | No voice *messages* (recorded audio in chat). Dictation exists, which covers the input side. Output-side voice messages are not started. | later |
| 2.2 | Remembers people, companies, events, preferences | Facts, entities, decisions, memories with embeddings; source, timestamp, confidence on every row. | — | done |
| 2.3 | Search the web | `web_search`, `web_fetch` (approval-gated) | — | done |
| 2.4 | Read and create files, understand images | Upload with MIME allowlist (images, PDF, text, CSV, JSON), signed private URLs, `create_file`. | Signed URLs expire after 30 days and the re-signing route is deferred (TODO in `attachments.ts`). An old thread's attachments will silently break. | should |
| 2.5 | Draft emails | `draft_email` (in-chat artifact) and connector `send` with `approval: always`. | — | done |
| 2.6 | **Inspect calendars** | `preview_calendar_event` only *proposes*. No calendar read, no calendar write, no calendar connector. | Calendar is one of the four named first integrations and is entirely absent. | blocking |
| 2.7 | Prepare actions through connected services | Gmail/Outlook read, search, send via the connector register. | Only email. See 2.6. | — |
| 2.8 | Rich responses: images, files, previews, sources, drafts, events, progress, approval cards | All present in `components/assistant-ui/elements/`. | — | done |
| 2.9 | Safe actions alone; consequential ones need approval | `web_fetch` and connector `send` gated; `draft_email` and `preview_calendar_event` never act. | — | done |

## 3. Memory

| # | Vision | Today | Gap | Severity |
|---|---|---|---|---|
| 3.1 | Extract facts, not messages | Detached extraction workflow per exchange; `MIN_USER_CHARACTERS` gate; interrupted call turns excluded. | — | done |
| 3.2 | Retrieve only what is relevant | `ContextPackage`: 12 facts, 6 entities, 4 decisions, 5 semantic hits, ~3200 chars. | — | done |
| 3.3 | Memories can be **inspected, corrected or deleted** | Every row carries source, timestamp and confidence — the data supports it. | **No surface for it.** The user cannot see what Maya believes about them, correct a wrong fact, or delete one. Nothing in `components/` or `app/` reads `facts` or `memories`. The vision puts this under trust, not under dashboards, so it belongs in Settings or in conversation ("what do you remember about X?"), not as a module. | should |

## 4. Connectors

| # | Vision | Today | Gap | Severity |
|---|---|---|---|---|
| 4.1 | Web search | Native. | — | done |
| 4.2 | Gmail or Outlook | Composio-brokered, least-privilege auth configs, register-driven, per-session discovery, fail-closed execution. | — | done |
| 4.3 | Google Calendar or Outlook Calendar | Nothing. | See 2.6. `PROVIDER_TOOLS`, a normalizer, a renderer and an approval preview for `event.create`. | blocking |
| 4.4 | File upload and generation | Done. | — | done |
| 4.5 | Configured in Settings, out of the main experience | Connections tab in the settings dialog; connector status in the sidebar. | — | done |

## 5. User experience

| # | Vision | Today | Gap | Severity |
|---|---|---|---|---|
| 5.1 | **No traditional dashboard.** Calendar, tasks, memory are not primary modules. | Sidebar links to Overview (`/`), Routine tasks, Calendar — all `PageSkeleton` placeholders. | The shell promises three modules the vision says not to build. The default screen is also `/` (a skeleton), not the conversation. Remove the three from `app-sidebar.tsx`, or make `/` redirect to `/assistants/maya`. | blocking |
| 5.2 | Default screen is the conversation with Maya | `/` is the Overview skeleton. | Redirect `/` → `/assistants/maya`. One line. | blocking |
| 5.3 | Header: name, role, online status, call buttons | Name, "AI assistant · available", two buttons. | Role reads "AI assistant", not "Chief of Staff". The vision wants both — the role is what makes her a colleague; the AI disclosure is separate (5.7). | should |
| 5.4 | Hide tool calls, DB operations, raw JSON; show human states | Chat does this. Video overlay does not (1.3). | Same fix as 1.3. | — |
| 5.5 | Premium, calm, minimal | Login page and chat are there. Dashboard skeletons are not. | Removing 5.1 resolves most of it. | — |
| 5.6 | English-first | `en` and `no` dictionaries; browser-negotiated. | Some Norwegian comments in `components/maya/*` (e.g. `maya-header.tsx:15`). Cosmetic, but the locked decision is English in code. | later |
| 5.7 | Always disclose she is AI | Header line and the Assistants card say "AI assistant". | Disclosure is present but is doing double duty as the role. Once 5.3 gives her the role back, disclosure needs its own home — a line under the name, or in the welcome. | should |
| 5.8 | Understandable, interruptible, controllable | Cancel in composer; approval cards; progress states. | Calls cannot be interrupted mid-tool: a delegation runs up to 25 s and the user hears silence. Barge-in stops the *speech*, not the *work*. | later |

## 6. Working between conversations

Not in `VISION.md`, but it is the literal meaning of "she handles the rest"
when the tab is closed, and phase 4 was built for it. Listed because it is where
the product is least proven.

| # | Intent | Today | Gap | Severity |
|---|---|---|---|---|
| 6.1 | A commitment fires when it is due | Durable timer per commitment, atomic claim, delivery protocol, heartbeat reconciler — all tested locally. | **P3 has never run.** Whether a detached workflow starts and survives a redeploy on Vercel is the single assumption everything rests on, and it is unverified at runtime. PHASE-4 §12 is explicit that phase 4 is not complete until it passes. | blocking |
| 6.2 | Recovery latency | Heartbeat `0 6 * * *`, because Hobby rejects anything more frequent. | If timers do not start, a reminder due Friday morning arrives Saturday at 06:00. Pro + `*/5 * * * *` makes recovery minutes. Account change, not code. | blocking (paired with 6.1) |
| 6.3 | Maya can reach the user | Resend outbox, frozen payloads, idempotency verified live. | `NOTIFICATIONS_ENABLED` is not set anywhere, and no Humanframe sender domain is verified — the only usable sender is `onboarding@resend.dev`, which delivers only to the Resend account owner. Nobody but Casper can receive an email. | blocking |
| 6.4 | Standing intentions, not just deadlines | `goals` table exists (migration `…_goals_and_commitments`). | No `set_goal` / `list_goals` tools, no goal extraction. Step 8 of the phase 4 order of work was never done. Maya keeps a date, not a purpose. | should |
| 6.5 | Something outside wakes her | Nothing. She wakes on user input, a timer, or the daily sweep. | No inbound trigger of any kind: no mail webhook, no calendar event, no morning brief. She is reactive with memory, not proactive. Deliberately out of phase 4/5 scope; it is the next product step after 6.1–6.3. | later |

## 7. Foundation and operations

| # | Item | Today | Gap | Severity |
|---|---|---|---|---|
| 7.1 | CI | None. 292 checks exist and are run by hand. | A workflow that runs `tsc`, `lint`, `build` and the seven suites on push. | should |
| 7.2 | Rate limiting | Only the call caps. Chat, upload and connector routes have none. | Phase 8 item. Needed before a public URL. | should |
| 7.3 | Billing | `lib/subscription.ts`: "Billing is not persisted yet". Upgrade and Billing tabs are UI only. | Fine for MVP; the tabs should not look purchasable until they are. | later |
| 7.4 | Google OAuth and SMTP in Supabase | Client id/secret present in `.env.local`. | Not verified end-to-end in this pass. | — |
| 7.5 | Deployment | Vercel project is linked (`.vercel/project.json`). | Could not read deployments from here (403). Whether a preview or production deploy exists and what its env is, is unknown from the repo. Prerequisite for 6.1. | — |

---

## Order

What the list says, if it is read as a plan:

1. **Close the shell to the vision** — 5.1, 5.2, 5.3/5.7. Half a day, no risk, and it is the thing a first visitor sees.
2. **Take the debug panel off the video overlay** — 1.3. Keep the metrics behind a query flag for development.
3. **Run P3** — 6.1, which needs 7.5 and 6.2 first. This is account work plus one preview deploy and a 26-hour wait. Until it is green, "she keeps working after you close the tab" is a claim, not a feature.
4. **Verify a sender domain** — 6.3. Account work.
5. **Calendar** — 2.6/4.3. The last missing named integration, and the one that makes "Chief of Staff" mean something.
6. **Goals** — 6.4. The cheapest step from remembering to pursuing.
7. **Memory inspection** — 3.3. The trust surface the vision asks for.
8. Then 6.5, the first inbound trigger.

Items 1–2 and 5–7 are code. Items 3–4 are yours.
