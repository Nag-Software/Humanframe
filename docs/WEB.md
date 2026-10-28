# Web: from request to job

Status: built 29 Oct 2026. Why web first, and how it differs from Snakk.ai,
is in [`PIVOT.md`](PIVOT.md). The phone channel is optional and documented in
[`RECEPTIONIST.md`](RECEPTIONIST.md); both feed the same pipeline.

## The flow

```
customer on the business's website
  │  <script src="https://<app>/widget.js" data-key="…">  → launcher + iframe /w/<key>
  │  (or the direct link /w/<key> from Google, Facebook, an email signature)
  ▼
conversation (server/widget)            draft inquiry from the first message
  │  asks what a tradesperson would ask: what, how big, where, photos, when,
  │  name and phone/email; photos go straight to storage on the inquiry
  ▼
"Send forespørsel"                      draft → open, processing pending
  ▼
pipeline (server/receptionist/processing.ts) — the same as a call
  │  intake → proposals: QUOTE (priced only from the owner's list), booking,
  │  reply; customer page created; owner alerted (SMS and/or email)
  ▼
owner, /inbox/<id>                      edit and approve with one tap
  │  quote → quote row (numbered) + message to the customer with their page
  ▼
customer, /k/<token>                    sees status and the quote, accepts or
                                        declines, picks a time, adds photos,
                                        writes a message — the owner is told
```

## What is where

| Area | Files |
|---|---|
| Schema | `supabase/migrations/20261029090000_web_requests.sql` |
| Widget | `app/widget.js/route.ts`, `app/w/[key]`, `app/api/widget/[key]/*`, `server/widget/*`, `components/widget/*` |
| Quotes | `server/receptionist/quotes.ts`, proposals in `intake.ts`, execution in `execute.ts`, `app/(app)/quotes` |
| Customer page | `app/k/[token]`, `app/api/portal/[token]`, `server/receptionist/portal*.ts`, `components/portal/*` |
| Email to customers | `server/receptionist/customer-email.ts` (business name as sender, reply-to the business) |
| Brand and components | `app/globals.css` (tokens), `app/layout.tsx` (fonts), `components/hf/*` |
| Design previews | `/preview/portal`, `/preview/actions`, `/preview/widget` — development, or `HUMANFRAME_PREVIEW=true` |

## Rules the code keeps

- **No invented prices.** The model suggests quote lines by price-list item
  name; `groundLines` drops any line whose item is not on the owner's list
  and takes unit and price from the list. No list, no quote proposal.
- **Nothing reaches the customer without the owner's tap**, except the
  customer's own actions on their page (accept, pick a time, message), which
  only notify the owner. A picked time becomes a booking proposal.
- **Every customer message carries the customer-page link.**
- **Drafts are invisible**: an unsent widget conversation never shows in
  Requests, the report or processing.
- **Limits**: 30 turns per conversation, 2 000 characters per message, 500
  conversations per workspace per day, upload links capped at twice their
  file limit.

## Switching it on

1. `supabase db push` (three new migrations since 28 Oct: the sign-up fix,
   the receptionist, and web).
2. Model access: `AI_GATEWAY_API_KEY` (or Vercel OIDC), or
   `RECEPTIONIST_MODEL_PROVIDER=openai` with `OPENAI_API_KEY`.
3. Email: `RESEND_API_KEY`, `NOTIFICATIONS_ENABLED=true` and a
   `NOTIFICATIONS_FROM` on a domain verified at Resend — quotes and replies to
   web customers go by email.
4. In the app: **Oppsett** → read the website, add the price list, save, copy
   the widget line onto the website.

SMS (Twilio) is optional on web: with it, customers who gave a phone number
get texts; without it, everything goes by email.
