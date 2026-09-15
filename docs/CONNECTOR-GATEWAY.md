# Connector gateway — decision log

Short record of what the preflight settled, before the refactor.

## Can Composio tools go straight into eve's manifest per turn?

No — and they don't need to. eve compiles authored tools at build time, so a
database-driven action set looks like it needs a deploy. `defineDynamic`
(eve 0.54.5, `agent/tools/*.ts`) is the way out: the resolver runs per session
and returns the tool map for *that* caller.

**Proven.** `eve build` compiles the dynamic module, and at runtime the same
build produced three different tool sets for one user as the register and grants
changed:

| State | Tools the model sees |
| --- | --- |
| Account connected, no grant | *(none)* |
| After a `read` grant | `gmail__email_read`, `gmail__email_search` |
| After disabling `email.read` in the register | `gmail__email_search` |

No deploy between those rows.

## Three eve constraints that shaped the code

1. **Callback bodies must be inline in an authored module.** eve snapshots them
   for durable replay; `execute: makeExecutor()` is not transformed and is
   rejected. So the resolver builds `defineTool` literals in a loop instead of
   calling a factory.
2. **Closure values must be JSON-serializable.** Each tool captures two strings
   — an action key and an account id — and looks up everything else when it
   runs. That is also the security property we want: no authorization decision
   is frozen into a tool at discovery time.
3. **Only `session.started` resolvers are rebound after a redeploy.** A parked
   approval must survive one, so the resolver is session-scoped. Freshness is
   not lost: the executor re-derives the register row, the account and the grant
   immediately before every call.

Bonus property, from eve's own semantics: if the resolver stops returning a
tool, a parked call to it **fails closed with an explicit error** rather than
invoking something else.

## Bug the tests caught

`payload_hash` was `sha256(JSON.stringify(payload))`. The payload round-trips
through `jsonb`, which does not preserve key order, so verification would never
have matched — and a payload check that never matches is one that gets deleted.
Hashing is now over canonical JSON with keys sorted recursively.

## What changes without a deploy

- Enabling or disabling an action per provider (`connector_actions.enabled`).
- Approval policy, risk, retry policy, capability required.
- Which shipped normalizer, result version and renderer an action uses.
- Repointing an action at a different provider tool slug — but only within the
  set this build knows how to call.
- Every per-user change: connecting an account, granting or revoking an
  assistant's capabilities, disconnecting.

## What still needs code

- A genuinely new *kind* of action: a new normalizer, a new versioned result
  contract, a new renderer.
- A new provider: `PROVIDER_TOOLS`, argument building, and the send strategy.
- Anything needing a new approval preview. An action whose preview cannot be
  rendered completely is blocked, not shown as raw JSON.

The register turns shipped capabilities on and off. It cannot invent them —
which is the point.

## Remaining security limits, stated plainly

- **A provider call already accepted cannot be recalled.** Revoking a grant or
  disconnecting an account stops *new* actions and invalidates pending ones. It
  does not unsend a message the provider has already accepted.
- **Neither Gmail nor Microsoft Graph supports idempotent send.** `unknown`
  stays terminal; there is no blind resend, and exactly-once is not claimed.
- **Composio holds the OAuth tokens.** A compromise of the broker is a
  compromise of the mailbox; Humanframe's controls sit above that, not under it.
- **Discovery is per session.** A grant revoked mid-session leaves the tool
  visible to the model until the next session; execution still fails closed,
  so the effect is a refusal rather than an action.
