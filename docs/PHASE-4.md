# Phase 4 — Goals, commitments, background work and the heartbeat

Status: **revision 3, approved architecture, partly implemented.** Written against
the code at `3dc7496` and the 15 applied migrations.

The core flow this has to deliver:

> "Remind me to follow up on this on Friday" creates a real commitment,
> schedules a durable workflow, and wakes Maya at the right moment. She then
> judges whether to act, prepare, ask for approval, or just notify.

## 0a. What revision 3 changed

- **The detached durable timer is the primary trigger, not an optimisation.**
  Cron cadence no longer bounds when a commitment fires. Each commitment gets
  its own durable workflow that sleeps until `due_at` and then enters the same
  atomic claim (§5.5). The heartbeat becomes what its name says: a reconciler
  for timers that were lost, never the only clock.
- **The hidden system marker is not, on its own, duplicate protection.** It is
  one of three defences, and the weakest, because it reads a projection written
  asynchronously by a hook. §5.2 now states the residual risk plainly and adds
  the two synchronous defences that actually carry the weight.
- **Every action carries a stable business idempotency key** (§10.1), not just
  every delivery. A key derived from the business subject — never a fresh uuid,
  never a timestamp — is what makes a repeated wake unable to repeat an effect.

## 0b. What revision 2 changed

Six corrections were required before implementation. Two of them change the
mechanism, not just the detail:

- **Delivery is now a single code path.** Revision 1 had two ways to wake Maya:
  an in-session background task that completes, and the heartbeat. Two paths
  means two claim semantics, two idempotency stories, and — fatally for
  correction 6 — a background task that *always* notifies the parent agent when
  it ends, even when the commitment was cancelled while it slept. There is now
  one deliverer (§5). The per-commitment durable timer is demoted to an
  optional precision trigger that calls the same claim (§5.5).
- **A delivery is a row, not an event.** `wake_seq` / `wake_attempts` cannot
  carry idempotency on their own, because a retry counter changes on every
  attempt and the key has to stay stable across them. `commitment_deliveries`
  now owns one stable `delivery_id` per logical reminder (§5.2).

Also corrected: lease recovery for stranded rows (§3.5), session recovery onto
the existing thread (§5.4), hardened internal auth (§6), cross-column workspace
integrity (§3.6), and silent cancellation (§7).

---

## 1. What eve already gives us

Read before designing anything, because most of phase 4 is composition
(`node_modules/eve/docs/`):

| Capability | eve surface | Used for |
|---|---|---|
| Durable timer that survives restart and deploy | a detached `"use workflow"` function + `await sleep()`, started with `start()` | The primary commitment trigger (§5.5) |
| Work that outlives the turn | `execution:"background"` → `{status:"working", taskId}` | Criterion 3 |
| Waking the agent with a result | Background completion notification starts a parent turn | Criterion 3 and 6 for *tasks* — deliberately **not** for commitments (§7) |
| Human approval inside long work | `ctx.ask(...)` — the `input.requested` event our approval card already renders | Criterion 7, reusing phase 2 UI |
| Cron | `agent/schedules/heartbeat.ts`; `withEve` turns it into a Vercel Cron Job | The deliverer |
| Replay safety | `"use step"` results are recorded and never re-run | Where every Supabase write goes |

Three eve facts that constrain everything below:

- **A workflow's identity is its module path + function name.** Once shipped,
  those files do not move or get renamed while runs are in flight.
- **A schedule handler gets only `{to, waitUntil, appAuth}`** — no
  `attachSession`, and `to(channel, target)` needs a channel with `receive`,
  which `eveChannel(...)` is not. The heartbeat reaches a session over HTTP
  (§5.3).
- **A background task always notifies the parent agent when its run ends.**
  That is why commitment wakes are not background tasks (§7).

## 2. Architecture

```
Supabase        permanent truth       goals, commitments, deliveries,
   ▲                                  tasks, events. Workspace-isolated.
   │ idempotent writes from "use step" functions and hooks
Workflows       the clock             one detached durable workflow per
   │                                  commitment: sleeps to due_at, then
   │                                  enters the claim. The primary trigger.
   ▼
Heartbeat       the reconciler        sweeps for commitments whose timer never
                                      fired, and for deliveries left mid-flight.
                                      A safety net, not the schedule.

Both triggers enter the same function. There is exactly one claim, one
delivery protocol, and one place that decides whether a wake happens at all.
```

`agent_runs` stays Humanframe's business projection: status, timing, cost, and
the references (`eve_session_id`, `eve_turn_id`, `workflow_run_id`) needed to
find the real log in Vercel. `events` follows the same rule — **one row per
business transition**, never one per eve stream event.

File placement (approved):

| Planned module | Location | Kind |
|---|---|---|
| `heartbeat.ts` | `agent/schedules/heartbeat.ts` | `defineSchedule({cron})` handler — reconciler only |
| `commitment-followup.ts` | `agent/lib/commitments.ts` + `agent/lib/delivery.ts` + `agent/lib/commitment-timer.ts` | store, delivery protocol and the detached timer, shared by every caller |
| `background-task.ts` | `agent/tools/run_background_task.ts` + `agent/lib/background-task.ts` | background workflow tool + steps |
| `approval-flow.ts` | `agent/lib/approval-flow.ts` | helper over `ctx.ask` and `approval: always()` |

## 3. Migration — `goals_and_commitments`

Additive, written to `supabase/migrations/` in the same turn it is applied.
Existing migrations are not edited. Every table carries `workspace_id` +
`assistant_id`, RLS via `public.is_workspace_member(workspace_id)`, and a
`set_updated_at` trigger — the `memory_core` shape.

### 3.1 `goals`

Standing intent, no deadline. `id, workspace_id, assistant_id, user_id, title,
detail, status ('active'|'paused'|'achieved'|'dropped'), priority real 0..1,
target_date date null, source_thread_id, source_message_id, dedupe_key,
created_at, updated_at`, with `unique (workspace_id, assistant_id, dedupe_key)`.

### 3.2 `commitments`

```
id, workspace_id, assistant_id, user_id,
goal_id            uuid null,
thread_id          uuid not null,          -- the conversation Maya wakes into
title, detail,
kind               'follow_up' | 'remind' | 'deliver',
owner              'user' | 'assistant',
due_at             timestamptz not null,   -- resolved instant
due_timezone       text not null,          -- the tz it was resolved in
status             'scheduled' | 'waking' | 'delivered' | 'in_progress'
                 | 'waiting_approval' | 'done' | 'cancelled' | 'failed',
wake_seq           int  not null default 0,   -- logical reminder counter
lease_token        uuid null,
lease_until        timestamptz null,
last_error         jsonb null,
source_thread_id, source_message_id,
dedupe_key, completed_at, cancelled_at, created_at, updated_at,
unique (workspace_id, assistant_id, dedupe_key)
```

`wake_attempts` is gone from this table: retries belong to the delivery, not to
the commitment (§3.3). `armed` is gone too — there is nothing to arm now that
delivery is claim-driven.

Indexes: `(status, due_at) where status in ('scheduled','waking')` for the
sweep, `(workspace_id, assistant_id, due_at desc)` for listing.

### 3.3 `commitment_deliveries`

One row per **logical reminder**. Its `id` is the `delivery_id`: stable across
every retry, regenerated only when a new logical reminder opens (a reschedule,
a snooze — a new `wake_seq`).

```
id                 uuid primary key,          -- the delivery_id
workspace_id, commitment_id, wake_seq int,
state              'pending' | 'sent' | 'confirmed' | 'abandoned',
attempts           int not null default 0,    -- retry counter, NOT identity
next_attempt_at    timestamptz,               -- backoff
target_session_id  text null,
target_kind        'existing_session' | 'new_session',
marker             text not null,             -- what we search for to reconcile
last_error         jsonb null,
sent_at, confirmed_at, created_at, updated_at,
unique (commitment_id, wake_seq)
```

### 3.4 `tasks` and `events`

`tasks` — `id, workspace_id, assistant_id, thread_id, commitment_id null,
goal_id null, title, input jsonb, status ('queued'|'running'|'waiting_input'|
'waiting_approval'|'succeeded'|'failed'|'cancelled'), result jsonb, error jsonb,
eve_session_id, eve_task_id, eve_call_id, workflow_run_id, idempotency_key,
started_at, ended_at`, `unique (workspace_id, idempotency_key)` keyed on the
replay-stable tool call id.

`events` — `id, workspace_id, assistant_id, subject_type
('goal'|'commitment'|'delivery'|'task'|'approval'), subject_id, type, payload
jsonb, thread_id, eve_session_id, eve_turn_id, occurred_at, idempotency_key`,
`unique (workspace_id, idempotency_key)`. Deterministic keys
(`delivery:<delivery_id>:sent`, `task:<id>:completed`) so
`insert … on conflict do nothing` is both the record and the audit trail.

`agent_runs` gains `origin text not null default 'user' check (origin in
('user','schedule','task','approval'))`.

`thread_sessions` — see §5.4. `workspace_members` gains `timezone text null`
(§8).

### 3.5 The claim function — correction 1

One atomic claim, used by **every** wake path. It recovers stranded `waking`
rows whose lease has expired, which is the whole point:

```sql
create function public.claim_commitments_for_wake(
  p_limit int, p_lease_ms int, p_id uuid default null)
returns setof public.commitments
language sql volatile security invoker as $$
  update public.commitments c
     set status      = 'waking',
         lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         -- a NEW logical reminder only when this row was not already waking;
         -- recovering a stranded row keeps its wake_seq, and therefore its
         -- delivery_id (§3.3).
         wake_seq    = c.wake_seq + case when c.status = 'waking' then 0 else 1 end,
         updated_at  = now()
   where c.id in (
     select id from public.commitments
      where status in ('scheduled', 'waking')       -- <- stranded recovery
        and due_at <= now()
        and (lease_until is null or lease_until < now())
        and (p_id is null or id = p_id)
      order by due_at
      limit p_limit
      for update skip locked)
  returning c.*;
$$;
```

Two callers, one predicate: the heartbeat passes `p_id => null`, the optional
precision trigger (§5.5) passes its own commitment id. Overlapping ticks cannot
claim the same row; an expired lease returns to the pool; a stranded `waking`
row is recovered without opening a second logical reminder.

**Every subsequent state change is lease-checked.** `complete_wake`,
`fail_wake`, `release_wake` are `update … where id = $1 and lease_token = $2`
and return the row count; zero rows means another worker owns the lease and the
caller stops, silently. A worker that lost its lease never writes.

The user-facing transitions (`complete_commitment`, `cancel_commitment`) do not
take the lease — they are allowed to win a race with a delivery in flight, and
§7 defines what the delivery then does.

### 3.6 Cross-column workspace integrity — correction 5

RLS protects `authenticated`. The runtime uses the **service role**, which
bypasses RLS entirely, so tenancy there has to be a database constraint rather
than a policy. Every cross-table reference becomes composite:

```sql
alter table public.threads    add constraint threads_id_workspace_key
  unique (id, workspace_id);
alter table public.assistants add constraint assistants_id_workspace_key
  unique (id, workspace_id);
-- and the same on goals, commitments, tasks

alter table public.commitments
  add constraint commitments_thread_fk
    foreign key (thread_id, workspace_id)
    references public.threads (id, workspace_id) on delete cascade,
  add constraint commitments_assistant_fk
    foreign key (assistant_id, workspace_id)
    references public.assistants (id, workspace_id) on delete cascade,
  add constraint commitments_goal_fk
    foreign key (goal_id, workspace_id)
    references public.goals (id, workspace_id) on delete set null;
```

The same treatment for `tasks.(commitment_id, workspace_id)`,
`tasks.(thread_id, workspace_id)` and `commitment_deliveries.(commitment_id,
workspace_id)`. A commitment in workspace A pointing at a thread in workspace B
is then rejected by Postgres, on the service-role path too. Tests exercise both
paths (§11).

## 4. Maya's new tools

| Tool | Kind | Approval | Purpose |
|---|---|---|---|
| `set_goal` | `defineTool` | no | Record or update a standing goal |
| `list_goals` | `defineTool` | no | Read them back |
| `schedule_followup` | `defineTool` | no | Write the commitment row and confirm in plain language. **No workflow, no sleep** — the deliverer owns the wake |
| `list_commitments` | `defineTool` | no | Outstanding and overdue |
| `complete_commitment` | `defineTool` | no | Mark done |
| `cancel_commitment` | `defineTool` | no | Cancel; see §7 |
| `run_background_task` | `defineWorkflowTool`, `execution:"background"` | no to start | Work that outlives the turn; each effect inside keeps its own approval |

`schedule_followup` being an ordinary tool is deliberate and is what makes
corrections 1, 2 and 6 tractable: creating a commitment is one idempotent row
write keyed on `ctx.callId`, and everything durable happens in the deliverer.

## 5. The delivery protocol

### 5.1 Claim

The heartbeat calls `claim_commitments_for_wake(limit, lease_ms)`. For each
claimed row it takes the lease token and proceeds. Nothing else in the
heartbeat touches commitments.

### 5.2 The delivery record — correction 2

```
upsert commitment_deliveries (commitment_id, wake_seq)
  on conflict do nothing
  -> row.id is the delivery_id, stable for this logical reminder
```

`delivery_id` identifies *what* is being delivered. `attempts` counts *how many
times we have tried*, and changing it never changes identity. A recovered
stranded row keeps its `wake_seq`, so it keeps its `delivery_id`, so a retry is
recognisably the same reminder rather than a new one.

**Releasing a lease therefore leaves the row in `waking`, not `scheduled`.**
The first implementation released to `scheduled`, and the next claim then read
it as a fresh reminder: `wake_seq` advanced, a second `delivery_id` was minted,
and the reconciliation in step 5 could never fire because the retry no longer
recognised its own earlier attempt. Tests 5, 7 and 8 caught it. Opening a new
logical reminder is a separate, explicit operation (`rescheduleCommitment`) for
a reschedule or a snooze — never a side effect of a retry.

The delivery then runs write-ahead:

1. `attempts := attempts + 1`, `next_attempt_at := now + backoff(attempts)`,
   state stays `pending`. **Committed before the HTTP call.**
2. Send (§5.3), with the marker embedded.
3. On a 2xx: state `sent`, `sent_at`. On observing the message in our own
   `messages` table: state `confirmed`.
4. On a definite failure (4xx that is not 409, refused connection): release the
   lease, leave `pending`, retry after backoff.
5. On an **ambiguous** failure — timeout, socket reset, crash after the request
   left the process, or a crash between 2xx and step 3 — the next attempt
   **reconciles before sending** (§5.3).
6. At `WAKE_MAX_ATTEMPTS` (default 5, exponential backoff 1/2/5/15/60 min):
   state `abandoned`, commitment `failed` with `last_error`, an event row, and
   the miss is surfaced in the user's next turn. A missed wake is never
   silently dropped.

**Crash windows, explicitly.** A crash before step 1 leaves the commitment
`waking` with a live lease; the lease expires and §3.5 recovers it with the same
`delivery_id`. A crash between 1 and 2 retries the send, which is why step 5
exists. A crash after 2 but before 3 is the ambiguous case. A crash after 3
leaves a `sent` row that reconciliation turns into `confirmed`.

**This is at-least-once, and the marker alone does not fix it.**

eve's follow-up route takes no idempotency key — `operationId` is create-only —
so the receiver offers no deduplication. Three defences stand between that and
a double wake, in order of how much weight they carry:

1. **The lease** (synchronous, authoritative). Only the lease holder may
   deliver, so two workers cannot send concurrently. This is the primary
   defence, and it holds as long as the lease outlives the send — so the send
   has an explicit timeout, and the lease is set well above it.
2. **The delivery row's own state** (synchronous, authoritative). A row in
   `sent` means *this process observed the receiver accept it*. No retry is
   attempted against a `sent` row; it is confirmed, not resent. Combined with
   the backoff in `next_attempt_at`, a retry cannot even be attempted until the
   previous one is definitively over.
3. **The marker** (asynchronous, advisory). Only for the genuinely ambiguous
   case: `pending` with attempts spent, where this process never learned the
   outcome. It reads `messages`, which `persist-turn.ts` writes from a hook —
   so a send that landed *seconds* ago may not be visible yet, and the marker
   can report "not landed" when it did.

**The residual risk, stated plainly.** If a send is accepted, the acknowledgement
is lost, *and* the projection has not caught up by the time the backoff expires,
a second wake is sent. The window is bounded by the shortest backoff (60s)
against hook latency (sub-second in practice), so it is small — but it is not
zero, and it cannot be closed from our side without an idempotency key on the
receiver.

What that costs when it happens: Maya is woken twice for one commitment. The
second wake finds the commitment already `delivered` or `done`, and answers in
one line. It does **not** repeat an action, because actions are keyed
independently of deliveries (§10.1). The failure mode is a redundant sentence,
never a duplicate effect.

### 5.3 Reaching the session, and the marker

The wake is delivered as a message into the thread's eve session:

```
POST {origin}/eve/v1/session/{sessionId}
Authorization: Bearer {fresh OIDC token}     (§6)
{"message": "[humanframe:delivery:<delivery_id>] <wake prompt>"}
```

Chosen over a custom `attachSession` channel (unverified whether `withEve`
serves non-`/eve/v1` channel routes) and over moving thread sessions to a custom
channel (would rewrite how the assistant-ui adapter creates sessions).

The `[humanframe:delivery:<id>]` prefix is the marker, and it is what makes
reconciliation possible: `persist-turn.ts` recognises it, persists the message
with `channel = 'system'` instead of `'chat'` so the UI never renders it, and a
retry queries `messages where eve_session_id = … and content @> marker` before
re-sending. Found → the previous attempt did land → mark `confirmed`, do not
resend.

### 5.4 Session recovery — correction 3

If the session answers `409 session_not_active`, the deliverer creates a new eve
session with `operationId = delivery:<delivery_id>` (eve's create-once
semantics) and **binds it to the commitment's existing `thread_id`**. It never
creates a second public thread: `threadId` is the user-visible conversation
identity and the commitment already points at one.

That needs `thread_sessions`:

```
thread_sessions (id, workspace_id, thread_id, eve_session_id unique,
                 reason 'initial'|'wake_recovery', created_at)
```

`threads.eve_session_id` stays as *the current* session and keeps its unique
index; `thread_sessions` is the full history. `resolveSessionTarget()` resolves
a session through `thread_sessions` first, then `threads`, so `persist-turn.ts`
projects messages from a recovered session into the same thread with no other
change.

**Continuity of history and context.** A new eve session starts with empty model
history — eve history is not transplantable, and we do not try. Instead:

- Supabase remains the canonical conversation; the thread reads identically to
  the user, because every session's messages project into the same `thread_id`.
- The wake prompt into a recovered session carries a bounded recap built from
  our own `messages` (last N turns of that thread, character-capped like
  `context-package.ts`), so Maya knows what "this" refers to.
- The phase 3 memory context package already injects profile, facts and
  relevant memories per turn, and is session-independent. That is the larger
  half of the continuity and it comes for free.
- The recap is marked as recollection, not as new user speech, using the same
  wording discipline as the memory package.

### 5.5 The timer: the primary trigger

`schedule_followup` writes the commitment row and then starts **one detached
durable workflow per commitment** — detached meaning started with `start()`
from `workflow/api` inside a `"use step"`, so the run belongs to no session's
task tree. Preflight P1 confirmed such a workflow registers as its own run
(`workflow//./agent/lib/commitment-timer//commitmentTimer`).

```ts
export async function commitmentTimer(input: { commitmentId: string; dueAt: string }) {
  "use workflow";
  await sleep(untilDue(input.dueAt));
  await wakeOnce(input.commitmentId);      // "use step"
}
```

`wakeOnce` calls `claimCommitmentsForWake(1, lease, commitmentId)` and, if it
gets the row, runs the delivery protocol in §5.1–5.4. Not a second code path:
the same claim, the same lease, the same delivery record, the same
cancellation check.

Being detached is what makes silent cancellation possible. A background task
attached to the session notifies the parent agent whenever its run ends — so a
cancelled commitment could not stay quiet. A detached run ends without telling
anyone: the claim simply returns no row (a cancelled commitment is not in
`scheduled` or `waking`), the timer returns, and nothing is delivered and no
turn is started.

**The heartbeat is then a reconciler.** Each tick claims what is due and
unleased — which, when timers work, is nothing. It exists for the cases the
timer cannot cover: a run lost to a workflow-storage expiry, a deploy that
orphaned it, a `start()` that failed after the commitment row was written, or a
delivery abandoned mid-flight by a crashed worker. Its cadence bounds *recovery*
latency, not *wake* latency, which is why cron granularity on Hobby stopped
being a product constraint.

One consequence worth stating: `start()` is not transactional with the row
write. A crash between them leaves a commitment with no timer — which is
precisely the case the heartbeat exists for, and why it must keep running even
once timers are trusted.

## 6. Internal auth — correction 4

The cryptography is eve's `verifyVercelOidc` — signature against the issuer's
JWKS, `iss`, `aud`, `exp`/`nbf`, and a binding to one project. The deliverer's
calls go through an `internalDeployment()` `AuthFn` placed ahead of
`vercelOidc()` in the walk, which adds what eve deliberately leaves open:

| Check | Owner |
|---|---|
| signature, `iss`, `aud`, `exp`/`nbf` | eve `verifyVercelOidc` |
| `project_id` equals this deployment's project | eve, re-asserted by us |
| **`environment` equals this deployment's environment** | **us** |
| **principal is a machine, not a person** | **us** |
| project binding present at all (else fail closed) | us |

The environment check is ours because eve's verifier accepts a same-project
token from *another* environment as a `service` principal — a documented and
reasonable default for cross-environment callers, and too wide for delivery: it
would let a preview deployment wake production users. Tested, and it was a real
gap, not a theoretical one (`tests/internal-auth.test.mts`).

The machine check matters for the same reason in the other direction: a local
`eve link` token carries a `user_id` and authenticates as a person. A person's
token is not this deployment calling itself.

The principal it returns carries **no scope**:
`{authenticator:"internal", principalType:"service", principalId:"humanframe:deliverer"}`.

**Scope comes from the stored commitment, never from the caller.** The wake
payload names a `delivery_id`; workspace, assistant, user and thread are read
from that row with the service-role client, and the target session must resolve
— via `thread_sessions`/`threads` — to that same `workspace_id`. A target
belonging to another workspace is rejected before a byte is sent.

**Token freshness.** `VERCEL_OIDC_TOKEN` is read inside the `"use step"` that
performs the send, at send time. It is never put in workflow input, never
captured before a `sleep`, and never written to a step result — step inputs and
results are persisted in durable workflow history, and a token that sat through
a 26-hour sleep is expired anyway.

Tests (`pnpm test:internal-auth`, 15/15): wrong project rejected, wrong
environment rejected in both directions, edited claims rejected, stripped
signature rejected, a person's token rejected, and an unbound runtime refusing
every internal caller. Acceptance of a *machine* principal cannot be asserted
locally — `eve link` only mints development user tokens — so that one assertion
is skipped locally and is part of P3 on Preview.

## 7. Cancellation — correction 6

**A commitment that is `done` or `cancelled` before its deadline produces no
delivery and no assistant turn.**

- `claim_commitments_for_wake` only claims `scheduled` and `waking`, so a
  cancelled row is never claimed. No delivery record, no HTTP call, no turn.
- A cancellation that lands *after* a claim but *before* the send: the deliver
  step re-reads the row inside the same step, sees the terminal status, marks
  the delivery `abandoned` with reason `cancelled`, releases the lease and
  sends nothing.
- A cancellation that lands after the send has already been accepted: the
  message is already in the session, so a turn happens. Maya's instructions
  cover it in one line ("that one is already handled") — the only case where
  cancellation is visible, and it is bounded by the width of the send.

This is precisely why commitment wakes are not background workflow tasks: a
background task notifies the parent agent whenever its run ends, including when
it ends early because the commitment was cancelled, so silence would be
impossible to guarantee. `run_background_task` keeps that mechanism, because
there a completion notification is exactly what is wanted.

## 8. Knowing when "Friday" is

`due_at` must be a real instant.

- `app/api/assistants/maya/session/route.ts` accepts a `timezone`
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and stores it on
  `workspace_members.timezone`.
- A dynamic instruction — the `agent/instructions/memory-context.ts` mechanism —
  injects `Current time` and `User timezone` at `turn.started`, failing open: no
  timezone means Maya asks rather than guesses.
- `agent/instructions.md` gains a short section: resolve relative dates against
  that timezone, say the resolved date back in plain language, never invent a
  deadline.

## 9. Approvals

No new approval system. `agent/lib/approval-flow.ts` calls `ctx.ask` with the
`approve`/`cancel` option ids the adapter already maps, writes the `approval`
event rows, and returns a typed decision. Anything with an external effect
inside a background task goes through it, so work that runs while nobody is
watching parks instead of acting, and the approval card is waiting in the thread
when the user returns.

## 10. Idempotency and isolation, per path

| Path | Key | Enforced by |
|---|---|---|
| Create a commitment | `ctx.callId` → `dedupe_key` | `unique (workspace_id, assistant_id, dedupe_key)` |
| Claim for wake | lease token + `for update skip locked` | `claim_commitments_for_wake` |
| Any wake state change | `where id = $1 and lease_token = $2` | zero rows ⇒ caller stops |
| Logical reminder identity | `delivery_id` | `unique (commitment_id, wake_seq)` |
| Retry vs. duplicate | marker lookup in `messages` before resend | `messages` + `channel='system'` |
| New session after 409 | `operationId = delivery:<id>` | eve create-once |
| Background task | `ctx.callId` → `idempotency_key` | `unique (workspace_id, idempotency_key)` |
| Business transitions | deterministic `idempotency_key` | `unique (workspace_id, idempotency_key)` on `events` |
| Cross-table tenancy | composite `(id, workspace_id)` FKs | Postgres, on the service-role path too |

### 10.1 Stable business idempotency keys for every action

A delivery being at-least-once is only tolerable because an action is not. Every
effect Maya performs — an email sent, a calendar event created, a file written,
an external API called — goes through an effect ledger keyed on **what the
action is, in business terms**, never on a fresh uuid, a timestamp, or an
attempt counter:

```
commitment:<commitment_id>:wake:<wake_seq>:action:<name>
task:<task_id>:action:<name>
approval:<approval_id>:grant
```

The ledger row is claimed before the effect runs and completed after, with the
same lease-and-reconcile discipline as a delivery: a crashed effect is retried
after its lease expires, and a completed one is never repeated no matter how
many times its wake arrives. A key that varies per attempt would make the
ledger decorative, which is why the shape above is derived entirely from
identifiers that are stable for the life of the business object.

An effect that cannot be made idempotent on our side — a provider with no
idempotency key and no way to query for a prior call — does not run
unattended. It goes through approval (§9) and a person absorbs the ambiguity.

## 11. Tests

Deterministic, no model calls, mandatory — `pnpm test:commitments`
(`tests/commitments.test.mts`, built on `tests/memory-support.mts`):

**Recovery and leasing** — implemented, 49/49 green (`pnpm test:commitments`)
1. Two concurrent claims → each row claimed exactly once.
2. A live lease is not re-claimable; an expired one is.
3. A stranded `waking` row with an expired lease is recovered, and keeps its
   `wake_seq` and `delivery_id`.
4. A state change with a stale `lease_token` writes nothing and reports zero
   rows.

**Delivery idempotence**
5. `delivery_id` is stable across attempts; `attempts` increments without
   changing it.
5a. Two workers racing the same commitment produce **one** visible wake: the
   loser is refused by the lease and writes nothing.
5b. A delivery in `sent` is never resent, even when the marker lookup would
   fail — the row's own state outranks the projection.
5c. A retry before `next_attempt_at` is refused.
5d. Two wakes that do arrive (the residual case in §5.2) produce at most one
   execution of an action, because the effect ledger key is stable (§10.1).
6. Crash before the send → retry sends once.
7. Crash after a 2xx but before `sent` → reconciliation finds the marker and
   confirms without resending.
8. Timeout after the receiver accepted → same, no duplicate.
9. `WAKE_MAX_ATTEMPTS` exhausted → `abandoned` + commitment `failed` + one
   event, and the miss is surfaced.

**Cancellation**
10. Cancelled before the deadline → no claim, no delivery row, no HTTP call.
11. Cancelled between claim and send → `abandoned`, lease released, nothing
    sent.

**Auth and isolation** — these gate internal delivery: it is not enabled until
they are green
12. Wrong `project_id` rejected; wrong `environment` rejected (a preview token
    cannot drive production, or the reverse); expired token rejected;
    wrong `aud` rejected; a token signed by the wrong key rejected.
13. A delivery whose target session resolves to another workspace is refused.
14. Composite FK: a commitment pointing at another workspace's thread,
    assistant or goal is rejected **through the service-role client**.
15. RLS: workspace B cannot read or claim workspace A's rows through an
    `authenticated` client.

**Time and tasks**
16. "Friday" in `Europe/Oslo` → the expected instant, including across DST.
17. `run_background_task`: queued → running → waiting_approval → succeeded, and
    the denied branch.

Opt-in live (`pnpm test:live:commitments`, an explicit `GatewayRateLimitError`
reported as `SKIPPED (external rate limit)` per the existing policy): one real
end-to-end with a 60-second `due_at`.

Plus the existing gates: `tsc`, `eslint`, `next build`, `pnpm test`,
`pnpm test:memory`.

## 12. Preflight

**P1 — mechanism (local). Passes at build level.** A `"use workflow"` function
in `agent/lib/` that is reachable from a tool compiles with no diagnostics and
registers as its own workflow in the build output
(`workflow//./agent/lib/probe-timer//probeTimer`), separate from the tool's own
`…//execute`. So a run can be started detached from the session's task tree.
Runtime proof is folded into P3. §5.5 depends on it: if a detached run turns
out not to start at runtime, the timer falls back to the heartbeat and cadence
bounds wake latency again.

**P2 — types (local). Passes.** `types/workflow.d.ts` containing
`/// <reference types="eve/workflow-modules" />` makes `workflow` and
`workflow/api` resolve, without setting `compilerOptions.types` (which would
stop every other `@types` package from being included automatically).

**P3 — the long-run test, on Vercel Preview.** This is the one assumption the
design rests on, and phase 4 is not finished until it passes. It runs on
**Preview**, with Preview-scoped variables. Production keeps
`NEXT_PUBLIC_MAYA_RUNTIME=ai-sdk` and gets no heartbeat until this is green.

1. Deploy a preview, and start a commitment due in **26 hours** (crossing the
   Hobby 1-day workflow-data retention window).
2. **Redeploy the preview while the timer sleeps**, so the run has to survive a
   deployment change.
3. Verify delivery afterwards, into **the same Humanframe `threadId`** — via the
   original session if it is still active, via §5.4 recovery if it is not.
   Either route is a pass; delivery into a *different* thread, or no delivery,
   is a failure.
4. Verify **fresh auth after the wait**: the OIDC token is minted at send time,
   and a token captured before the sleep would have expired.
5. **Rate limit at wake**: force a 429 at wake time and confirm exponential
   backoff, the attempt cap, and that an exhausted delivery lands as
   `abandoned` rather than a silent loss.
6. **Failure windows**: kill the process between claim and delivery-row write,
   between write and send, and between a 2xx and `sent` — confirm §5.2 handles
   each without duplicate or loss.
7. **Timer vs. reconciler**: confirm the timer delivered, and that the
   heartbeat found nothing to do. Then delete a timer's run and confirm the
   heartbeat recovers that commitment.

**P4 — cron cadence.** Read back Settings → Cron Jobs after deploy. Now that
the timer is the primary trigger, cadence bounds only how fast the reconciler
notices a lost timer — hours is tolerable, a day is not ideal but not broken.

**What Preview needs before P3 can start.** `lib/env.ts` fails closed, and the
`NEXT_PUBLIC_*` pair is inlined at build time, so all of these must exist in the
**Preview** environment before the build:

| Variable | Scope | Type |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Preview | Config |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Preview | Config |
| `SUPABASE_SERVICE_ROLE_KEY` | Preview | Secret |
| `OPENAI_API_KEY` | Preview | Secret |
| `APP_URL` | Preview | Config — the preview deployment's own origin |
| `NEXT_PUBLIC_MAYA_RUNTIME=eve` | Preview | already set |

Uploading the two secrets is the account owner's call. Production stays
untouched: no eve, no heartbeat, `ai-sdk` as before.

### What preflight already caught

- **`eve build` reads the agent config at build time.** Pointing
  `agent/agent.ts` at `MAYA_MODEL` broke the build immediately, because
  `.env.local` still held the AI SDK route's bare id (`gpt-5.6-luna`) in that
  variable. The model has since gone back to being a literal that eve owns, and
  the AI SDK route's variable is now `MAYA_LEGACY_MODEL` so the two names can
  never be confused again. The general lesson holds for any agent-config value
  that reads env: eve resolves it at compile time, so it fails the build rather
  than falling back at runtime.
- **Supabase default privileges survive `revoke … from public`.** The claim
  function was callable by any signed-in browser session until it was revoked
  from `anon` and `authenticated` by name (migration
  `20260915084700_claim_function_privileges`). Test 15 is what caught it.

## 13. Order of work

1. P1, P2 (local, no deploy).
2. Migration + local file + regenerated DB types.
3. `agent/lib/commitments.ts` and `agent/lib/delivery.ts`, with tests 1–15
   green before any tool exists. **This is where phase 4 is won or lost.**
4. `schedule_followup`, `list_commitments`, `complete_commitment`,
   `cancel_commitment` and their instructions.
5. Timezone plumbing and the "now" dynamic instruction (§8), test 16.
6. `agent/schedules/heartbeat.ts` wiring the claim to the delivery protocol.
7. `run_background_task` + `approval-flow.ts`, test 17.
8. `set_goal`/`list_goals` and goal extraction (one more candidate kind in the
   phase 3 extraction hook).
9. Full verification, then P3 — started as early as step 6 allows, since it
   runs for more than a day. **Phase 4 is not declared complete before P3
   passes.**
10. Nothing — §5.5 moved into step 4, because the timer is now primary.

## 14. Explicitly out of scope

No new UI surface — commitments live in conversation, `/routine-tasks` stays a
placeholder. No notifications outside the app. No calendar writes, no Composio.
No multi-assistant scheduling. No cross-workspace goals.
