# Phase 4 — Goals, commitments, background work and the heartbeat

Status: **proposal, not implemented.** Written against the code at `bdc0ba6`
and the 15 migrations currently applied. Nothing in here is built until it is
reviewed.

The core flow this has to deliver:

> "Remind me to follow up on this on Friday" creates a real commitment,
> schedules a durable workflow, and wakes Maya at the right moment. She then
> judges whether to act, prepare, ask for approval, or just notify.

---

## 1. What eve already gives us

Read before designing anything, because most of phase 4 is composition, not new
machinery (`node_modules/eve/docs/`):

| Capability | eve surface | What it means here |
|---|---|---|
| Durable timer that survives restart and deploy | `defineWorkflowTool` + `await sleep("...")` from `workflow` | The Friday wake is a workflow suspension, not a poller |
| Work that runs while the conversation continues | `execution: "background"` → tool returns `{status:"working", taskId}`, completion arrives later as session input | Criterion 3, natively |
| Waking the agent with a result | Background task completion notification starts a parent turn in **the same session** | Criterion 6, natively |
| Human approval inside long work | `ctx.ask({prompt, display:"confirmation", options})` — the same `input.requested` event our approval card already renders | Criterion 7, reuses phase 2 UI |
| Cron | `agent/schedules/<name>.ts` with `defineSchedule({cron})`; `withEve` turns each into a Vercel Cron Job | The heartbeat |
| Cancelling a background task | provided tool `eve/tools/task_cancel` | Cancel a scheduled follow-up |
| Replay safety | `"use step"` functions are recorded and never re-run after they complete | Where every Supabase write goes |

Two eve facts that constrain the design:

- **A workflow's identity is its module path + function name.** Renaming or
  moving an executor orphans in-flight runs. Once a commitment workflow ships,
  its file does not move.
- **A schedule handler gets only `{ to, waitUntil, appAuth }`.** It cannot
  `attachSession(...)`; `to(channel, target)` needs the target channel to
  implement `receive`, and our channel is `eveChannel(...)`, which is addressed
  by session id over HTTP. See §5 for how the heartbeat reaches a thread.

## 2. Architecture

Three layers, with one owner each:

```
Supabase        permanent truth       goals, commitments, tasks, events
   ▲                                  survives everything; workspace-isolated
   │ idempotent writes from "use step" functions and hooks
Workflows       the mechanism         the durable sleep, the parked approval,
   │                                  the retried step. Owned by eve.
   ▼
Heartbeat       the reconciler        one cron that repairs what the mechanism
                                      lost. Never the primary path.
```

The rule from phase 2 still holds and gets sharper: **`agent_runs` is
Humanframe's business projection.** It stores status, timing, cost, and the
references (`eve_session_id`, `eve_turn_id`, `workflow_run_id`) needed to find
the real log in Vercel. It never becomes a copy of the event stream. The new
`events` table follows the same rule: **one row per business transition**
(commitment armed, woke, completed, approval granted), never one row per eve
stream event.

### Deviation from the original plan

`docs/PLAN.md` §2 put the workflow modules under `server/workflows/`. Under eve
that is not where they can live: a cron must be a file in `agent/schedules/`
and a durable workflow must be a `defineWorkflowTool` under `agent/tools/`.
The four named modules map like this:

| Planned module | Actual location | Kind |
|---|---|---|
| `heartbeat.ts` | `agent/schedules/heartbeat.ts` | `defineSchedule({cron})` handler |
| `commitment-followup.ts` | `agent/tools/schedule_followup.ts` + `agent/lib/commitment-followup.ts` | background workflow tool + shared steps |
| `background-task.ts` | `agent/tools/run_background_task.ts` + `agent/lib/background-task.ts` | background workflow tool + shared steps |
| `approval-flow.ts` | `agent/lib/approval-flow.ts` | helper over `ctx.ask` + `approval: always()` |

The `agent/lib/*` halves exist so the heartbeat and the workflow tools share
exactly one implementation of "arm a commitment", "record a wake", "finish a
task" — which is what makes the two paths converge instead of double-acting.

## 3. Migration — `goals_and_commitments`

One new migration, additive, written to `supabase/migrations/` at the same time
it is applied. Existing migrations are not edited. All four tables carry
`workspace_id` + `assistant_id`, RLS `for all to authenticated` via
`public.is_workspace_member(workspace_id)`, and `set_updated_at` triggers, the
same shape as `memory_core`.

**`goals`** — standing intent, no deadline.
`id, workspace_id, assistant_id, user_id, title, detail, status
('active'|'paused'|'achieved'|'dropped'), priority real 0..1, target_date date
null, source_thread_id, source_message_id, dedupe_key text, created_at,
updated_at`, with `unique (workspace_id, assistant_id, dedupe_key)` so repeated
extraction of the same goal updates one row (same pattern as `memories`).

**`commitments`** — a promise with a deadline. This is the phase 4 centre.
```
id, workspace_id, assistant_id, user_id,
goal_id            uuid null references goals,
thread_id          uuid not null references threads,   -- where Maya wakes
title, detail,
kind               'follow_up' | 'remind' | 'deliver',
owner              'user' | 'assistant',
due_at             timestamptz not null,               -- resolved instant
due_timezone       text not null,                      -- the tz it was resolved in
status             'scheduled' | 'armed' | 'waking' | 'in_progress'
                 | 'waiting_approval' | 'done' | 'cancelled' | 'failed',
wake_seq           int not null default 0,             -- increments per wake attempt
wake_attempts      int not null default 0,
lease_token        uuid null,
lease_until        timestamptz null,
last_error         jsonb null,
eve_session_id     text null,                          -- session that armed it
workflow_run_id    text null,
source_thread_id, source_message_id,
dedupe_key text, completed_at, created_at, updated_at,
unique (workspace_id, assistant_id, dedupe_key)
```
Indexes: `(status, due_at)` partial on the live statuses for the heartbeat
sweep, and `(workspace_id, assistant_id, due_at desc)` for listing.

**`tasks`** — one unit of background work.
`id, workspace_id, assistant_id, thread_id, commitment_id null, goal_id null,
title, input jsonb, status ('queued'|'running'|'waiting_input'|
'waiting_approval'|'succeeded'|'failed'|'cancelled'), result jsonb, error jsonb,
eve_session_id, eve_task_id, eve_call_id, workflow_run_id, idempotency_key,
started_at, ended_at`, with `unique (workspace_id, idempotency_key)`. The key is
derived from the tool call id, which is replay-stable, so a retried step claims
the same row.

**`events`** — the business timeline.
`id, workspace_id, assistant_id, subject_type ('goal'|'commitment'|'task'|
'approval'), subject_id uuid, type text, payload jsonb, thread_id,
eve_session_id, eve_turn_id, occurred_at, idempotency_key`, with
`unique (workspace_id, idempotency_key)`. Every writer supplies a deterministic
key (`commitment:<id>:wake:<seq>`, `task:<id>:completed`), so an
`insert ... on conflict do nothing` both records the transition and decides who
owns it. This table is also the audit trail for approvals.

**`agent_runs`** gains one column: `origin text not null default 'user' check
(origin in ('user','schedule','task','approval'))`, so a run can be traced to
why it happened without storing anything else new.

**One SQL function**, because the lease has to be atomic:
```sql
create function public.claim_due_commitments(p_limit int, p_lease_ms int)
returns setof public.commitments
-- update commitments set status='waking', lease_token=gen_random_uuid(),
--   lease_until=now()+..., wake_seq=wake_seq+1, wake_attempts=wake_attempts+1
-- where id in (select id from commitments
--              where status in ('scheduled','armed') and due_at <= now()
--                and (lease_until is null or lease_until < now())
--              order by due_at limit p_limit for update skip locked)
-- returning *;
```
`security invoker`, called by the runtime's service-role client. Two heartbeat
ticks overlapping cannot claim the same row; an expired lease returns to the
pool.

## 4. Maya's new tools

All named and described for a colleague, not for a machine. Read-only tools get
no approval (same reasoning as `recall`); tools with an external effect keep the
existing approval policy.

| Tool | Kind | Approval | Purpose |
|---|---|---|---|
| `set_goal` | `defineTool` | no | Record or update a standing goal for this workspace |
| `list_goals` | `defineTool` | no | Read them back |
| `schedule_followup` | `defineWorkflowTool`, `execution:"background"` | no | **The durable one.** Writes the commitment, sleeps until `due_at`, wakes Maya |
| `list_commitments` | `defineTool` | no | What is outstanding, what is overdue |
| `complete_commitment` | `defineTool` | no | Mark done; a live wake finds the row already closed and stays quiet |
| `cancel_commitment` | `defineTool` | no | Cancel; pairs with `eve/tools/task_cancel` for the parked run |
| `run_background_task` | `defineWorkflowTool`, `execution:"background"` | no to start | Real work that outlives the turn; each *effect* inside it keeps its own approval |

`schedule_followup`, in outline — the whole of criterion 2 and 4:

```ts
export default defineWorkflowTool({
  description: "...",
  inputSchema: z.object({ title, detail, dueAt, kind }),
  execution: "background",
  async execute(input, ctx) {
    "use workflow";
    const commitment = await armCommitment(ctx, input);   // "use step", idempotent on ctx.callId
    await sleep(untilDue(input.dueAt));                   // durable suspension
    const wake = await openWake(ctx, commitment.id);      // "use step", claims wake_seq
    return wake;                                          // completion notification → parent turn
  },
});
```

- `armCommitment` upserts on `(workspace_id, assistant_id, dedupe_key)` where
  the dedupe key comes from `ctx.callId`. A replayed step returns the same row.
- `openWake` re-reads the row inside the step. If it is `done` or `cancelled`
  it returns `{status:"already_handled"}` and Maya acknowledges in one line.
  Otherwise it writes the `commitment:<id>:wake:<seq>` event and flips the row
  to `in_progress` — and that event key is the same one the heartbeat would
  use, so the two paths can never both wake her for the same deadline.

## 5. The wake path, and the one hard problem

The happy path needs no cron: the background task completes, eve starts a turn
in the session that owns the thread, `persist-turn.ts` projects the messages,
and the result is in the same conversation. Criteria 2, 3, 4, 6 fall out of it.

The hard case is when that run is gone — a workflow that was garbage-collected,
a deploy that dropped an orphaned run, a wake that errored. Then the heartbeat
has to reach a thread's session from a schedule handler that has no
`attachSession`. Options considered:

1. **Loopback to our own eve channel** — the schedule `fetch`es
   `POST {origin}/eve/v1/session/:sessionId` with
   `Authorization: Bearer ${VERCEL_OIDC_TOKEN}`, which the existing auth walk
   already accepts through `vercelOidc()` (and `localDev()` locally). No new
   route, no new secret, no change to `agent/channels/eve.ts`. **Chosen.**
2. A custom channel with an internal route using `attachSession`. More code,
   and it is unverified whether `withEve` serves non-`/eve/v1` channel routes
   from the Next app.
3. Moving thread sessions onto a custom channel so `to(channel, {threadId})`
   works. Correct in eve terms, but it changes how the assistant-ui adapter
   creates sessions — too invasive for phase 4.

If the session answers `409 session_not_active`, the heartbeat creates a fresh
session through `POST /eve/v1/session` with `operationId =
commitment:<id>:wake:<seq>` (eve's create-once semantics) and then claims a
thread for it. That requires two small additions:

- an internal principal (`authenticator: "internal"`, `principalType:
  "service"`, `attributes: {workspaceId, assistantId, userId}`) accepted by the
  auth walk when the OIDC caller is our own deployment;
- `resolveSessionTarget` / `resolveMemoryScope` learning to read scope from
  those attributes instead of only from a Supabase user principal.

Degraded mode, if delivery fails `WAKE_MAX_ATTEMPTS` times: the commitment goes
to `failed` with `last_error`, an event is written, and the next time the user
speaks, the context package surfaces it ("this was due Friday and I could not
reach you"). A missed wake is never silently dropped.

**The heartbeat does nothing else.** It does not poll eve, mirror runs, or scan
messages. Its whole body is: claim due commitments → deliver → release or
complete → expire stale leases.

## 6. Knowing when "Friday" is

`due_at` has to be a real instant, so the agent needs the user's timezone and
the current time. Neither is available today.

- `app/api/assistants/maya/session/route.ts` starts accepting a `timezone` from
  the client (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and stores it
  on the workspace member row (new nullable column, same migration).
- A dynamic instruction — the same mechanism as
  `agent/instructions/memory-context.ts` — injects `Current time: <ISO>` and
  `User timezone: <tz>` at `turn.started`. It fails open: no timezone means
  Maya asks instead of guessing.
- `agent/instructions.md` gains a short section: resolve relative dates against
  that timezone, state the resolved date back in plain language, and never
  invent a deadline the user did not give.

## 7. Approvals

No new approval system — phase 2's is the one. `agent/lib/approval-flow.ts` is
a thin helper that (a) calls `ctx.ask` with the `approve` / `cancel` option ids
the adapter already maps, (b) writes the `approval` event rows, and (c) returns
a typed decision. Anything with an external effect that a background task wants
to perform goes through it, so a task that runs on Friday at 09:00 while nobody
is watching parks instead of acting, and the approval card is waiting in the
thread when the user comes back.

## 8. Idempotency and isolation, per path

| Path | Key | Enforced by |
|---|---|---|
| Arm a commitment | `ctx.callId` → `dedupe_key` | `unique (workspace_id, assistant_id, dedupe_key)` |
| Wake (either path) | `commitment:<id>:wake:<seq>` | `unique (workspace_id, idempotency_key)` on `events` |
| Claim for wake | lease token + `for update skip locked` | `claim_due_commitments` |
| Background task | `ctx.callId` → `idempotency_key` | `unique (workspace_id, idempotency_key)` on `tasks` |
| New session for a lost wake | `operationId` | eve create-once |
| Messages / runs / tool calls | unchanged | existing unique indexes |

Workspace isolation: RLS on all four tables; the runtime uses the service role
and always filters by the scope resolved from the session, never from a tool
argument — the rule `recall` already follows.

## 9. Tests

Deterministic, no model calls, mandatory (`pnpm test:commitments`, a new
`tests/commitments.test.mts` built on `tests/memory-support.mts`):

1. Relative-date resolution: "Friday" in `Europe/Oslo` → the expected instant,
   including across a DST boundary.
2. `armCommitment` twice with the same call id → one row.
3. `claim_due_commitments` from two concurrent callers → each row claimed once.
4. An expired lease is re-claimable; a live one is not.
5. Two wakes with the same `wake_seq` → one `events` row, one delivery.
6. A commitment completed before its wake → `already_handled`, no second turn.
7. Workspace isolation: workspace B cannot see or claim workspace A's rows.
8. `run_background_task` state machine: queued → running → waiting_approval →
   succeeded, and the denied branch.

Opt-in live (`pnpm test:live:commitments`, rate limit reported as SKIPPED per
the existing policy): one real end-to-end with a 60-second `due_at` — ask for a
follow-up, confirm the receipt, wait, confirm Maya wakes in the same thread and
the row closes.

Plus the existing gates: `tsc`, `eslint`, `next build`, `pnpm test`,
`pnpm test:memory`.

## 10. Preflight — verify before building, not after

1. **Vercel cron frequency on Hobby.** A `* * * * *` heartbeat may not be
   permitted on the current plan. Deploy one trivial schedule and read back
   Settings → Cron Jobs. If minute granularity is not available, the heartbeat
   runs at the coarsest allowed cadence — it is only the reconciler, so the
   product still works — and Pro becomes a precondition for production.
2. **A workflow run that sleeps across the retention window.** `docs/PLAN.md`
   already flags that Hobby keeps workflow data 1 day after a run *completes*,
   and that a *waiting* run should not be affected. Prove it: a background task
   with a 26-hour sleep, confirmed to wake. This is the single assumption the
   whole design rests on.
3. **Reaching a days-old session.** Same experiment, then
   `POST /eve/v1/session/:id`. If it 409s, §5's new-session path is not a
   fallback but the normal path, and `threads.eve_session_id` (unique, one per
   thread) needs a `thread_sessions` child table so one conversation can span
   several eve sessions. Do not write that migration before the test says so.
4. **OIDC loopback.** Confirm `vercelOidc()` accepts a request carrying the
   runtime's own `VERCEL_OIDC_TOKEN`. If not, add `HUMANFRAME_INTERNAL_TOKEN`
   as a shared secret and a fourth `AuthFn`.
5. **`workflow` types.** `import { sleep } from "workflow"` is ambient and
   needs `eve/workflow-modules`. Add `types/workflow.d.ts` with a
   `/// <reference types="eve/workflow-modules" />` rather than setting
   `compilerOptions.types`, which would change which `@types` packages are
   included globally.

## 11. Order of work

1. Preflight 1–5. Results decide §5 and the migration's final shape.
2. Migration + `supabase/migrations/` file, regenerate DB types.
3. `agent/lib/commitments.ts` (store: arm, claim, wake, complete, fail) with
   tests 2–7 green before any tool exists.
4. `agent/tools/schedule_followup.ts`, `list_commitments`,
   `complete_commitment`, `cancel_commitment`; instructions for when to use
   them.
5. Timezone plumbing + the "now" dynamic instruction (§6), test 1.
6. `agent/schedules/heartbeat.ts` + the delivery path (§5).
7. `agent/tools/run_background_task.ts` + `agent/lib/approval-flow.ts`, test 8.
8. `set_goal` / `list_goals` and goal extraction from ordinary conversation
   (reuses the phase 3 extraction hook, one more candidate kind).
9. Full verification, then the live test.

## 12. Explicitly out of scope

No new UI surface. Commitments appear in conversation, not in a dashboard —
`/routine-tasks` stays a placeholder. No notifications outside the app (no
email, no push): an outbox is a separate piece of work. No calendar writes, no
Composio. No multi-assistant scheduling. No cross-workspace goals.
