# The receptionist — how it works and how to switch it on

Status: built 2026-10-28 on `claude/bold-wozniak-d35wwp`. The code, the
migration and the 102 deterministic checks (`pnpm test:receptionist`) are in
place. **It has not taken a real phone call yet**: that needs the accounts in
§3, and the wire details in §5 must be checked against a test call before a
customer depends on it. The product reasoning is in [`PIVOT.md`](PIVOT.md).

---

## 1. What happens on a call

```
caller ──► business's own number ──(forward on no answer / busy)──► Humanframe number (Twilio)
                                                                      │
             /api/telephony/voice ◄────────────── Twilio asks what to do
             │  opens an inquiry (keyed on CallSid)
             │  TwiML: <Say> greeting + "this call is recorded"
             │         <Dial record="record-from-answer-dual"><Sip>sip:<project>@sip.api.openai.com?X-Humanframe-Inquiry=<id>
             ▼
   OpenAI Realtime SIP ──► /api/telephony/openai  (realtime.call.incoming)
             │  builds instructions: profile, hours, prices, FAQ, the owner's
             │  rules, caller history, free slots (calendar read ≤ 2.5 s)
             │  POST /v1/realtime/calls/{id}/accept
             ▼
   the AI talks with the caller (Norwegian, discloses it is an AI,
   never confirms anything itself)
             │
   call ends ──► /api/telephony/dial-status   (AI never connected → voicemail)
             └─► /api/telephony/recording     (recording ready)
                    after(): download WAV → split caller/AI channels →
                    Whisper per channel → interleaved transcript →
                    intake (model) → proposals (code) → delete recording →
                    SMS + email to the owner with a link to /inbox/<id>
```

The owner opens the link and approves each proposal with one tap:

| Proposal | What approving does |
|---|---|
| **Book time** | Writes a booking, creates the event in Google Calendar if connected, texts the customer a confirmation. Refuses a clash unless the owner says "book anyway". |
| **Send SMS med lenke** | Creates a 14-day photo-upload link (`/u/<token>`), texts it to the customer, plus the "more info" URL if asked for. |
| **Send svar** | Texts the customer a reply drafted from the call. Editable first. |
| **Ring tilbake** | Shown for urgent calls; approving records that the owner called. |

Nothing reaches a customer or the calendar without that tap. A proposal is
claimed atomically, so a double tap runs once; an SMS whose provider did not
answer is marked `unknown` and never retried automatically.

Other paths:

- **Silent call** (hung up during the greeting): becomes "Ubesvart anrop" with
  a proposed "Hei! Vi så at du ringte …" text back. This is the lost-call
  recovery the weekly report counts.
- **Inbound SMS**: a reply within 7 days joins that customer's inquiry and is
  forwarded to the owner; anything else becomes a new inquiry through the same
  intake.
- **AI unavailable** (not configured, rejected, error): the caller gets
  voicemail; the voicemail is transcribed and handled the same way.
- **Remembering callers**: earlier inquiries from the same number go into the
  instructions, so the AI can greet a returning customer.

The weekly report goes out Monday 06:00 UTC to owners and admins, and lives on
`/reports`.

## 2. Code map

| Area | Files |
|---|---|
| Schema | `supabase/migrations/20261028120000_receptionist.sql` |
| Profile, time, slots | `server/receptionist/{profile,time,slots,availability}.ts` |
| Learn from a website | `server/receptionist/{web,onboarding}.ts` (SSRF-guarded crawl + model) |
| Prompt and intake | `server/receptionist/{prompt,intake,processing}.ts` |
| Approvals | `server/receptionist/execute.ts`, `app/api/receptionist/actions/[actionId]` |
| SMS, uploads, alerts | `server/receptionist/{sms,uploads,notify}.ts` |
| Report | `server/receptionist/report.ts`, `app/api/cron/weekly-report` |
| Twilio | `server/telephony/{twilio,inbound}.ts`, `app/api/telephony/*` |
| OpenAI SIP | `server/telephony/openai-sip.ts`, `app/api/telephony/openai` |
| Transcripts | `server/telephony/{wav,transcribe}.ts` |
| Calendar | `server/calendar/{google,ics}.ts`, `app/api/calendar/feed/[token]` |
| Screens | `app/(app)/{inbox,setup,reports}`, `app/u/[token]`, `components/receptionist/*` |
| Schedules | `agent/schedules/{receptionist,weekly-report}.ts` → `/api/cron/*` |

## 3. Switching it on

### 3.1 Database

```bash
supabase db push
```

Applies `20261028120000_receptionist.sql`. It was checked against Postgres 17
(PGlite) together with every earlier migration.

### 3.2 Twilio

1. Create the account and a **regulatory bundle for Norway** (company and
   address). Norwegian numbers cannot be bought without it.
2. Set the variables in §4. `TWILIO_BUNDLE_SID` and `TWILIO_ADDRESS_SID` are
   passed when a number is bought from **Oppsett → Få resepsjonistnummer**,
   which also points the number's voice and SMS webhooks at this deployment.
3. A number bought by hand in the Twilio console works too: set its voice URL
   to `https://<app>/api/telephony/voice` and its SMS URL to
   `https://<app>/api/telephony/sms` (both POST), and insert it:
   ```sql
   insert into phone_numbers (workspace_id, e164, provider_sid)
   values ('<workspace id>', '+47…', 'PN…');
   ```
   Only numbers on our own Twilio account may be attached; a form that
   accepted any number would let anyone route someone else's calls.

### 3.3 OpenAI Realtime SIP

1. In the OpenAI project: enable SIP, and add a webhook for
   `realtime.call.incoming` pointing at `https://<app>/api/telephony/openai`.
2. Copy the webhook signing secret (`whsec_…`) and the project id
   (`proj_…`) into `OPENAI_WEBHOOK_SECRET` and `OPENAI_PROJECT_ID`.

### 3.4 Google Calendar (optional, recommended)

1. In Composio, create an auth config for the `googlecalendar` toolkit pinned
   to `calendar.freebusy`, `calendar.events` and `userinfo.email`, and set
   `COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID`.
2. Pin the toolkit version in the register, exactly as for email:
   ```sql
   update connector_actions set tool_version = '<version>'
   where provider = 'googlecalendar';
   ```
   Unpinned rows fail closed: no busy times are read and bookings are written
   without a calendar copy (the booking itself still stands and shows the
   error).

Without Google Calendar, slots come from opening hours minus Humanframe's own
bookings, and the owner can subscribe to the ICS feed shown in Oppsett from
any calendar app.

### 3.5 Sign-in emails

Paste `supabase/templates/magic_link.html` into **Authentication → Email
Templates → Magic Link** (and the same into **Confirm signup**), and make
sure **Site URL** is the app's URL and `https://<app>/auth/callback` is in
the redirect allow-list. The template carries both a token-hash link (works
in any browser) and the 6-digit code the login page now accepts.

### 3.6 Schedules

Set `CRON_SECRET`. The eve schedules call `/api/cron/receptionist` daily
05:15 UTC (the processing safety net) and `/api/cron/weekly-report` Mondays
06:00 UTC.

## 4. Environment

| Variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Required. The token also verifies every Twilio webhook. |
| `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | Optional REST credentials instead of the account token. |
| `TWILIO_NUMBER_COUNTRY` | Default `NO`. |
| `TWILIO_BUNDLE_SID`, `TWILIO_ADDRESS_SID` | Regulatory bundle for buying Norwegian numbers. |
| `TWILIO_NOTIFY_FROM` | Sender for the owner's alerts (a number or an alphanumeric name). Defaults to the business's own sender. |
| `TWILIO_DEFAULT_SMS_FROM` | Fallback sender for a workspace with no number yet. |
| `OPENAI_API_KEY` | Already used for Call; also accepts SIP calls and transcribes. |
| `OPENAI_PROJECT_ID`, `OPENAI_WEBHOOK_SECRET` | Realtime SIP. Without them, every call goes to voicemail. |
| `PHONE_MODEL`, `PHONE_VOICE` | Default `gpt-realtime`, `marin`. |
| `TRANSCRIPTION_MODEL` | Default `whisper-1` (segment timestamps are needed). |
| `RECEPTIONIST_MODEL`, `RECEPTIONIST_MODEL_PROVIDER` | Website reading and intake. Default `openai/gpt-5-mini` through the gateway. |
| `COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID` | See §3.4. |
| `CRON_SECRET` | Required for the schedules. |
| `RESEND_API_KEY`, `NOTIFICATIONS_ENABLED` | Existing; the owner's email alert and the weekly report use them. |

## 5. Verify before the first customer

These are the provider details the code relies on, written from the
providers' documentation without a live account to test against. Each is in
one adapter file, so a difference is a one-file fix.

- [ ] **Twilio signature** over the public URL (`server/telephony/twilio.ts`).
      A 403 in the logs on the first call means the URL Twilio signed differs
      from `APP_URL` + path; set `APP_URL` to the exact public origin.
- [ ] **Dual-channel order**: caller on channel 1, AI on channel 2. If the
      transcript has the speakers swapped, swap `roles` in
      `server/telephony/transcribe.ts`.
- [ ] **SIP header** `X-Humanframe-Inquiry` arrives in
      `data.sip_headers` of `realtime.call.incoming`.
- [ ] **Accept body** `{ type: "realtime", model, instructions, audio.output.voice }`
      is accepted, and the AI speaks Norwegian on dialect: call it yourself in
      Bergen dialect before selling anything (PIVOT.md).
- [ ] **Composio calendar tools** `GOOGLECALENDAR_FIND_FREE_SLOTS` and
      `GOOGLECALENDAR_CREATE_EVENT` take the arguments in
      `server/calendar/google.ts`, at the pinned version.
- [ ] **Forwarding codes** `**61*`, `**67*`, `**62*` on Telenor, Telia and Ice
      mobiles, and the switchboard path for one Telavox/Telia customer.
- [ ] **Recording deletion**: the recording is gone from Twilio after
      processing (`recording_deleted_at` is set).

## 6. Privacy

- The greeting says the call is recorded and answered by a digital assistant
  before the AI joins (`buildGreeting`). Owners can change the words, not the
  obligation: keep both facts in a custom greeting.
- The audio is deleted at Twilio as soon as it is transcribed. The transcript
  stays with the inquiry.
- Photo-upload tokens are stored only as their sha-256 and expire after 14
  days; the page can add files, never read them.
- A data processing agreement (databehandleravtale) with each customer, and
  Twilio/OpenAI as sub-processors, is a contract task, not code.

## 7. Not built

- **Live transfer to the owner** during the call (OpenAI SIP `refer`). The AI
  takes the message instead; urgent calls get a "Ring tilbake" proposal and an
  SMS marked HASTER.
- **Booking during the call.** The AI offers real free times and notes the
  caller's choice; the owner confirms with one tap and the customer gets the
  SMS. This is deliberate (PIVOT.md: "med eierens godkjenning").
- **Outlook calendar** read/write. Outlook users subscribe to the ICS feed.
- **Receptionist minutes in billing.** `lib/plans.ts` still meters Maya's
  call and video minutes; the PIVOT.md price plans (990/1 990/3 990 kr) are
  not in Stripe yet.
- **Known limits, accepted for now:** two bookings for the same slot approved
  at the same instant can both pass the clash check (no exclusion constraint);
  two simultaneous "get number" clicks could buy two Twilio numbers; any
  workspace member, not only owners, can edit and send a proposed SMS.
- **Dashboards for the call log.** The weekly report counts forwarded calls;
  comparing with the operator's call log is done with the customer, as
  PIVOT.md describes.
