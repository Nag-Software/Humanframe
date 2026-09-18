# Humanframe

An operating system for digital employees. The first one is **Maya** — a Chief of
Staff you chat with, call, and meet face to face, who remembers you between
conversations and keeps working after you close the tab.

The product vision lives in [`docs/VISION.md`](docs/VISION.md), the architecture
and phase plan in [`docs/PLAN.md`](docs/PLAN.md), and the data model in
[`docs/DATA-MODEL.md`](docs/DATA-MODEL.md).

## Stack

| Layer | Choice |
| --- | --- |
| App & API | Next.js 16 (App Router), TypeScript, Vercel |
| Chat UI | assistant-ui + shadcn/ui |
| Agent runtime | [eve](https://eve.dev) (preview), mounted in this app with `withEve` |
| Durable execution | Vercel Workflows |
| Model routing | Vercel AI Gateway (OIDC in preview/production) |
| Database, auth, storage | Supabase (Postgres, RLS, pgvector, Storage) |

## Getting started

```bash
pnpm install
pnpm dev
```

`next dev` also boots the eve runtime and mounts it at `/eve/v1/*` on the same
origin. Check it with:

```bash
curl http://localhost:3000/eve/v1/health
```

### Environment

Copy the values into `.env.local` (never committed):

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only; used by background work, never by a request handler that has a user session |
| `APP_URL` | Origin used for auth callbacks |
| `OPENAI_API_KEY` | The phase 1 chat route and, later, GPT-Live |
| `MAYA_LEGACY_MODEL` | OpenAI model id for the phase 1 chat route |
| `AI_GATEWAY_API_KEY` | Optional local fallback when Vercel OIDC is unavailable |
| `NEXT_PUBLIC_MAYA_RUNTIME` | `ai-sdk` (default) or `eve` |
| `RESEND_API_KEY` | Server-only. Email notification; absent means nothing is sent |
| `NOTIFICATIONS_ENABLED` | `true` to allow sending in this environment. Default `false` |
| `NOTIFICATIONS_FROM` | Sender address for notification email |
| `NOTIFICATIONS_ALLOWLIST` | Comma-separated addresses. When set, only these can be emailed |

Maya's own model is not an environment variable. eve owns it as a literal in
`agent/agent.ts`; change it with `eve set --model <id>` or `/model <id>` in the
dev TUI. eve resolves the agent config when it compiles the manifest, so the
change takes effect on the next build.

Model access in preview and production runs on Vercel OIDC. Locally, `eve link`
populates `VERCEL_OIDC_TOKEN`.

### Database

Migrations live in `supabase/migrations/` and are applied with the Supabase CLI:

```bash
supabase db push
```

Every tenant-owned table carries a `workspace_id`, and row level security is
expressed as membership in `workspace_members`. A signup trigger provisions a
personal workspace, an `owner` membership and a Maya for each new user;
`ensure_user_bootstrap()` makes that idempotent for OAuth sign-ins.

## Layout

```
agent/        eve agent: instructions, tools, channels (filesystem-first)
app/          Next.js routes — (app) is the signed-in shell, (auth) is login
components/   assistant-ui elements, Maya chat, auth UI, shadcn primitives
lib/          env validation, i18n, Supabase clients, shared helpers
server/       runtime seam, repositories, request scope — never imported by the UI
supabase/     migrations and CLI config
```

Two boundaries matter: the UI never imports the agent runtime directly, and
nothing outside `server/agent/runtime/` imports `eve` on the server. eve is in
preview, so it sits behind the `AgentRuntime` interface.

## Checks

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

### Billing (Stripe)

Humanframe has no free plan. Billing is off unless `BILLING_ENABLED=true`, and
with it off nothing is gated and Stripe is never called.

| Variable | Purpose |
| --- | --- |
| `BILLING_ENABLED` | `true` to require a plan and report overage to Stripe |
| `STRIPE_SECRET_KEY` | Server-only |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the `/api/billing/webhook` endpoint |
| `STRIPE_PRICE_*`, `STRIPE_METER_*` | The catalogue; printed by `pnpm stripe:setup` |

`pnpm stripe:setup` creates the products, prices (Starter/Pro, monthly/yearly),
the two usage meters with their per-minute overage prices, and the $3 trial
pass — idempotently — and prints the variables. Plans, minutes and overage
rates live in `lib/plans.ts`; the setup script and the marketing site use the
same numbers.

Flow: Settings › Billing → Checkout (3-day trial paid as one $3 pass, then the
plan) → webhook mirrors the subscription into `subscriptions` and
`workspaces.plan` → every ended call reports its seconds beyond the plan to
the meter, once, keyed on the call id → Stripe invoices the overage per started
minute with the next renewal. Plan changes, card and cancellation happen in
the Stripe customer portal (Manage billing).
