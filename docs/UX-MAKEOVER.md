# UI/UX makeover — from an assistant in a shell to a relationship with Maya

Status: proposal, 2026-09-18. Written against the code on `facetime` at
`7ea310b` and the gaps in [`GAPS.md`](GAPS.md).

## The thesis this serves

Customers stay with Humanframe because they have a relationship with Maya and
would rather not leave her — not because of a feature list. Calls and FaceTime
are not features on top of a chat product; they are the mechanism that builds
the attachment. Maya still has to do real work, well, because attachment built
on anything other than usefulness churns the moment the novelty fades.

Every decision below is judged by one test:

> **Does this make Maya more of a person to the user, or more of a tool?**

A dashboard makes her a tool. A face makes her a person. A greeting that knows
what happened yesterday makes her a person. A "New conversation" button makes
her a tool. A call that leaves a trace in your shared history makes her a person.

## 1. What makes her a tool today

Read against the code, not the intention:

1. **She meets you as a stranger every time.** `/assistants/maya` without a
   thread id renders "Hi, I'm Maya — ask me anything, I can search, write and
   build files." There is no history in the UI (`listThreads` exists in the
   repository but nothing calls it), so every visit starts a new thread with an
   introduction. A colleague does not re-introduce herself each morning.
2. **She is a leaf in a SaaS tree.** Sidebar: team switcher "Humanframe" →
   Overview → Assistants → *Maya* → Routine tasks → Calendar → Settings, with a
   breadcrumb above her. Three of those are empty skeletons.
3. **Her identity line is a category.** The header says "AI assistant ·
   available". Not her role, not her state — a product category.
4. **The relationship mechanism is the smallest thing on screen.** Call and
   FaceTime are two 16 px ghost icons in the top-right corner.
5. **Calls have no beginning and no end.** Pressing the icon drops you into a
   blurred modal; hanging up drops you back with nothing to show a call
   happened. The transcript is persisted, but the stream shows no trace.
6. **She never speaks first.** Commitment wakes land as messages, but nothing in
   the UI signals it, and a new day never opens with her.
7. **The video surface shows nine latency metrics.** It also apologises for
   itself ("Prototype: Maya cannot see you…").

None of these are hard to change. Together they are why she reads as software.

## 2. The five mechanics of a relationship, as UI

| Mechanic | What it means for a person | What it becomes in Humanframe |
|---|---|---|
| **Presence** | She is *there*, with a face, before you say anything | The presence bar (§3.2). Her face, her name, her current state — not a role label, not a status dot |
| **Continuity** | One relationship, not a pile of sessions | One stream, grouped by day (§3.3). History is "earlier", not "threads". `/` opens where you left off |
| **Initiative** | She reaches out; it is not always you | She speaks first on a new day when she has something; her follow-ups arrive as *her* messages, marked as hers (§5) |
| **Memory** | She remembers, and you can see that she does | Her greeting references yesterday. Her profile shows what she is holding and what she remembers, editable (§3.5) |
| **Ritual** | You do things together, at moments — not just when a task appears | The first meeting is a call (§6). Calls ring, have a shape, and leave a trace (§4). A morning check-in is one tap |

## 3. Layout

### 3.1 Window anatomy

Remove the sidebar as primary navigation. The window *is* the conversation.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⋮≡   ◯ Maya                                        ( Call ) ( FaceTime ) │  presence bar, 56px
│      Back to you Friday about the Nordvik offer                    ⋯  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│                         ── Yesterday ──                               │
│   ◯  I went through the three offers. Nordvik is the only one …       │
│                                                                       │
│                                  You: ok, hold that until Friday  ▐   │
│                                                                       │
│   ◯  Will do. I'll come back to you Friday morning.                   │
│                                                                       │
│   ┌──────────────────────────────────────────────┐                    │
│   │ 📞 Call · 6 min                               │                    │
│   │ We went through Q4 hiring. Two follow-ups.    │                    │
│   └──────────────────────────────────────────────┘                    │
│                                                                       │
│                         ── Today ──                                   │
│   ◯  Morning. Two things from yesterday are still open, and Anna      │
│      replied to the offer last night — want me to summarise it?       │
│                                                                       │
├──────────────────────────────────────────────────────────────────────┤
│  [+]  Write to Maya…                                        🎤   ➤   │  composer
└──────────────────────────────────────────────────────────────────────┘
```

- `⋮≡` top-left opens the **drawer** (§3.4): earlier conversations, and the
  link to her profile. Also `⌘K`.
- `⋯` top-right is the **you** menu: account, language, billing, sign out.
  The user's settings live here; *Maya's* settings live on her profile.
- No breadcrumb, no team switcher, no "Humanframe" wordmark inside the app.
  The brand is on the login page and in the window title. Inside, she is the
  brand.

Routes after the makeover:

| Route | Today | After |
|---|---|---|
| `/` | Overview skeleton | The conversation. Opens the most recent thread (§3.3) |
| `/assistants`, `/assistants/maya` | Card + chat | Redirect to `/`, keep `?t=` working |
| `/calendar`, `/routine-tasks` | Skeletons | Removed. Their *content* moves to her profile |
| `/maya` | — | Her profile (§3.5) |
| Settings dialog | Account, Billing, Upgrade, Notifications, Connections | Account, Billing, Upgrade, Language under the *you* menu. Notifications and Connections move to her profile |

The `components/assistant-ui/elements/` layer does not change. It is the
best-built part of the UI, and this plan is about the frame around it.

### 3.2 The presence bar

Replaces `MayaHeader`. It is the single most important 56 pixels in the
product: it is where she *is*.

```
◯  Maya                                                ( 📞 Call ) ( 📹 FaceTime )
   Reading Anna's reply…
```

- **Face** at 40 px, not 32. Her portrait, not an icon.
- **Name** only. The role ("Chief of Staff") lives on her profile and in the
  first meeting; it does not need to be repeated 200 times a day.
- **State line**, replacing "AI assistant · available". This is what changes
  her from a label to a person. In priority order:
  1. What she is doing right now: "Reading Anna's reply…", "Searching…",
     "Drafting…" — the human-readable tool states already in `tool-ui.tsx`.
  2. On a call: "On a call with you · 03:12".
  3. The nearest thing she is holding: "Back to you Friday about the offer"
     (from `commitments`, next due). This shows, at a glance and constantly,
     that she is carrying something for you.
  4. Otherwise: "Here" — not "available", not "online". Or nothing.
- **Call and FaceTime** as labelled pills, 36 px tall, tinted, always
  visible. They are the point of the product; they get the space.
- **AI disclosure** does not live here. It lives in the first meeting, on her
  profile under "How I work", and in every email she sends. Once each, where
  it is read, not as a permanent caption under her name.

### 3.3 The stream: one relationship

The backend keeps threads (eve sessions have compaction and limits; that is the
right unit for the runtime). The *UI* presents one continuous relationship:

- **`/` opens the most recent thread.** Never an empty introduction for a
  returning user. `listThreads(limit 1)` already exists.
- **Continuity rule:** continue the latest thread if it was active within the
  last 24 hours. Otherwise start a new thread — but the new thread opens with
  *her* first message, grounded in memory and open commitments (§5), not with
  a static greeting. To the user, both cases look like the same stream.
- **Day separators** ("Yesterday", "Tuesday 16 Sep") inside a thread, and the
  same separator style between threads in the drawer. The user never sees the
  word "thread".
- **Her face on the first message of each group** she sends; not on every
  bubble. Warmth without clutter.
- **Events in the stream**, rendered as quiet cards, not chat bubbles:
  - `Call · 6 min` with her one-line summary and any commitments made. This is
    the trace that makes a call part of the shared history (§4.4).
  - `Maya followed up` marker on messages she initiated from a commitment
    wake, so her initiative is visible as hers.
- **"Start fresh"** exists, in the drawer, deliberately secondary. Some users
  want a clean slate for a new topic. It is never the default and never a
  button in the composer.

### 3.4 The drawer

Slides in from the left over the stream (`⋮≡`, `⌘K`, or swipe on touch). It
is not a sidebar; it is closed 95 % of the time.

```
┌──────────────────────┐
│ ◯ Maya               │  → her profile
│   Chief of Staff     │
├──────────────────────┤
│ Earlier              │
│  Today               │
│   Q4 hiring, Anna's… │  ← her own one-line summary of each thread
│  Yesterday           │
│   Three offers       │
│  Mon 15 Sep          │
│   Standup agenda     │
│   Travel to Bergen   │
├──────────────────────┤
│ + Start fresh        │
└──────────────────────┘
```

Thread titles are written by Maya (a one-line summary at thread close or on
first idle), not the first user message. `threads.title` exists.

### 3.5 Her profile — `/maya`

This is where the dashboard goes to become a person. Everything the vision
says must not be a module — calendar, tasks, memory, connectors — lives here,
framed as *her*: what she is holding, what she remembers, what she can reach,
how she works.

```
┌──────────────────────────────────────────────────────────────┐
│                                                               │
│                     [ large portrait ]                        │
│                          Maya                                 │
│                      Chief of Staff                           │
│              Working with you since 14 Sep 2026               │
│                                                               │
│        ( 📞 Call )   ( 📹 FaceTime )   ( ✎ Write )            │
│                                                               │
├──────────────────────────────────────────────────────────────┤
│ What I'm holding for you                                      │
│   Fri 19 Sep   Come back on the Nordvik offer        follow-up │
│   Mon 22 Sep   Remind you about the board deck        reminder │
│                                                               │
│ What I remember                                        Edit   │
│   You run Nag Software with two engineers.                    │
│   You prefer short written answers and calls for decisions.   │
│   Anna Berg is your contact at Nordvik.               ✕       │
│   …                                                           │
│                                                               │
│ What I can reach                                              │
│   Gmail · casper@…          read, search, send with approval  │
│   Google Calendar           not connected          ( Connect ) │
│   Web                       always                            │
│                                                               │
│ How I work                                                    │
│   I'm an AI. I act on my own only when it's reversible …      │
│   Quiet hours 21:00–07:00 · Email me when …                   │
└──────────────────────────────────────────────────────────────┘
```

- **What I'm holding** is the `commitments` table. It replaces
  `/routine-tasks` entirely and closes the "tasks as a module" contradiction.
- **What I remember** is `facts` + `entities`, editable and deletable. This is
  the trust surface the vision asks for (GAPS 3.3), and it is a relationship
  moment: seeing that she got something right — or fixing it — is exactly
  what you do with a person. Correcting a fact writes `superseded_by`; it never
  hard-deletes the source.
- **What I can reach** is the Connections tab, moved. "Give Maya access to
  your mail" reads differently from "Connectors".
- **How I work** is the AI disclosure, the approval rule in one paragraph, and
  the notification settings. It is honest and it is *hers*.
- **Working with you since** is the one number on the page. No streaks, no
  counts of messages, no "you've spent 4 h together". One date.

## 4. Calls and FaceTime — the hero

These are the product. They should feel like the best thing in it.

### 4.1 Ringing

A call has a beginning. Pressing Call today jumps to a blurred overlay that
says "Connecting…". Connection takes one to two seconds anyway; make that time
*ringing*:

```
                 [ portrait, 160 px, soft ring pulsing ]
                              Maya
                          Calling…
                                                   ( ✕ )
```

Then the ring settles, the state becomes "Here", and she speaks. Same for
FaceTime, with the portrait dissolving into the video when the first frame
arrives. The first thing she says on a call is written by her from context
("Hi — you wanted to go through the offers?"), never a fixed line.

### 4.2 The voice surface

Keep what `call-overlay.tsx` already does well — face, one line of state, two
controls, no waveform, no transcript ticker. Three changes:

- **Full-window, darker.** `bg-background/80` blur over the chat reads as a
  modal. A call is a place, not a dialog: near-black, her face lit, the chat
  gone. Escape or End brings the chat back.
- **Duration**, small, under her name. Not a countdown, not a budget. Time
  together, the way FaceTime shows it.
- **"Continue in chat"** — a third control. The call keeps running and the
  chat returns with a slim bar under the presence bar: `On a call with Maya ·
  03:12 · [End]`. You can paste her a link, show her a file, or read her draft
  while talking. That is what you do with a colleague on the phone.

### 4.3 The video surface

- **Full-bleed video**, controls floating at the bottom, name small at the
  top-left. Controls fade after three seconds without pointer movement and
  return on movement — the FaceTime rule the vision names.
- **No metrics.** The nine measurements in `facetime-overlay.tsx` move behind
  `?debug=1`. They were the right tool for building the prototype and the wrong
  thing to ship.
- **The camera line, said once, by her.** Instead of a permanent "Prototype:
  Maya cannot see you" banner, she says it in the first FaceTime, in her words:
  "I can't see you yet, by the way — only you can see me." It is true, it is
  disclosed, and it is a person saying it. The `CAMERA_DENIAL` instruction
  stays in the prompt.
- **Self-view** appears only when camera perception exists. Until then there
  is nothing to show and no reason to ask for the camera.

### 4.4 The trace

When a call ends, the stream gets a card:

```
┌────────────────────────────────────────────────┐
│ 📞 Call · 6 min · 09:14                         │
│ We went through Q4 hiring. I'll draft the two   │
│ job posts and come back to you Thursday.        │
│ ── Holding: draft job posts · Thu 18 Sep        │
└────────────────────────────────────────────────┘
```

The summary is one delegation to eve at hang-up (the same path
`runDelegation` uses mid-call), written into the thread as a system-channel
message the UI renders as this card. Calls stop being ephemeral and become
chapters in a shared history — which is what makes them relationship-building
rather than novelty.

### 4.5 Later: she calls you

When a commitment is due and the user is in the app, Maya can *ring*: the
presence bar state becomes "Maya is calling…" with Answer / Message instead.
Declining sends the follow-up as a message. This is the strongest initiative
move available and it is cheap once §5 exists. Not in the first pass, because
it must be earned by reliability first: a wrong-time call is worse than none.

## 5. She speaks first

### 5.1 Opening the day

When the continuity rule starts a new thread, the *first message is hers*,
generated from the context package and open commitments:

> Morning. Two things from yesterday are still open — the Nordvik offer and
> the board deck. And Anna replied last night. Want me to start with that?

Rules that keep this a relationship and not a nag:

- **Only when she has something.** Open commitments, a reply that arrived, a
  file she finished. If there is nothing, she says nothing, and the composer
  simply waits — a person does not greet you with filler.
- **Name once**, at most, at the start of a day. Not in every message.
- **No pleasantries without content.** "How are you today?" from software is
  the fastest way to make it feel like software.
- **Never "How can I help you?"** That is a shop assistant's line, not a
  colleague's.

Implementation: on a new-thread start, the session route sends a system turn
("open the day") instead of waiting for user input; the reply streams into the
empty stream. If the model returns nothing to say, no message is written.

### 5.2 Her follow-ups

Commitment wakes already produce assistant messages. Make them *visibly hers*:

- A quiet `Maya followed up` label above the message.
- The document title and favicon show unread state (`(1) Maya`) while the
  tab is in the background. No red badges inside the app.
- When the app is closed, the email doorbell (already built, waiting on a
  sender domain — GAPS 6.3) carries the same line, first person, with one link.

### 5.3 What she must not do

- Fake typing indicators when nothing is running.
- Artificial delays to seem human. She is fast; that is fine.
- Claims of feelings. "I've been thinking about your offer" is a lie from a
  workflow; "The Friday follow-up on the offer is due" is not.
- Guilt or urgency: no "you haven't talked to me in a while".
- Streaks, points, or any gamification of contact.

Attachment has to come from her being reliably good. Every one of these
shortcuts borrows against that.

## 6. The first meeting

Today a new user lands on "Hi, I'm Maya. Ask me anything." The first minute
decides whether this is a person or a chatbot. Make it a *meeting*:

```
                    [ large portrait ]

                         Meet Maya
              Your Chief of Staff. She remembers,
              follows up, and works while you don't.
                   She is an AI, and will say so.

              ( 📞 Start with a call )   recommended
                  ( ✎ Start by writing )
```

On the call (or in writing), she leads — the same first-meeting instruction on
either channel:

1. What should I call you, and what do you do?
2. What is on your plate this week?
3. How do you like to work — short and written, or talk it through?
4. Anything I should know about the people you work with most?

Then: "I'll check in tomorrow morning. Anything you want me to look into before
then?" — and she creates that commitment.

What this does, all at once: it starts the relationship the way relationships
start (talking), it seeds `facts`/`entities` through the existing extraction
path so day two already feels personal, and it schedules the first wake, which
means the very first day exercises the loop the product depends on.

The first meeting runs once per workspace. A flag on `workspaces` records that
it happened; it can be replayed from her profile.

## 7. Voice, copy and material

**Copy**

- She speaks in the first person, everywhere: "I'll come back Friday", not
  "A follow-up has been scheduled".
- Placeholder: "Write to Maya". Not "Message Maya", not "Ask anything".
- Starters, if kept, are about *the user's* week, generated from memory — not
  "Summarise the latest AI news from Norway". On day one, before memory exists,
  the first meeting replaces them.
- No exclamation marks. No emoji in her messages unless the user uses them.
- English first. Norwegian remains available; the tone rules apply in both.

**Material**

- Near-monochrome. One accent, used for exactly two things: the call pills and
  the send button. The tinted emerald ring on calls is good; keep it.
- Typography: the existing `font-display` for her name and headings; system
  text elsewhere. Nothing new.
- Motion: state-line transitions (cross-fade, 200 ms), the ringing pulse, and
  control fade on video. That is the whole motion vocabulary. No portrait
  "breathing" — a still photo that moves is uncanny. An ambient idle *video*
  of her in the presence bar is an experiment for later, tested with real
  users before it ships.
- Dark mode is first-class on the call and video surfaces, and neutral
  elsewhere.

## 8. Measuring whether it works

Not a dashboard. PostHog events, read weekly:

| Signal | Why it matters |
|---|---|
| Weekly returning users | The vision's own success criterion |
| Share of sessions **she** opened | Initiative is real, not decorative |
| Calls + FaceTime per active user per week | The mechanism is being used |
| **D30 retention, split by "had ≥1 call in week 1"** | The thesis itself, as a number |
| Median days between sessions | Relationship rhythm |
| Commitments completed on time | She is reliable |
| Memory corrections per user | Trust surface is used (some corrections are healthy; many means extraction is wrong) |

If the split in row four does not separate, the thesis is wrong and the plan
should be revisited before more is built on it.

## 9. Phasing

Each phase ships on its own and is valuable alone. Effort is for one person who
knows the codebase.

| Phase | What | Effort | Depends on |
|---|---|---|---|
| **A. The frame** | Remove sidebar, dashboard routes and breadcrumb. `/` → latest thread. Presence bar with state line. Call/FaceTime as pills. Drawer with earlier conversations. `/maya` profile with static sections. Copy pass. | 2 days | — |
| **B. Calls as the hero** | Ringing state. Full-window voice surface with duration and "Continue in chat" bar. Video: full-bleed, fading controls, metrics behind `?debug`. Post-call card via one delegation. Camera line spoken once. | 2–3 days | A |
| **C. She speaks first** | Opening-the-day turn on new thread. Day separators. `Maya followed up` marker. Unread in title/favicon. Maya-written thread titles. | 2 days | A; P3 (GAPS 6.1) for the follow-ups to be trustworthy in production |
| **D. The first meeting** | Onboarding flow on either channel, workspace flag, first commitment. | 1–2 days | B, C |
| **E. Her profile, live** | Commitments list, memory inspect/edit/delete, connectors and notification settings moved in. | 2–3 days | A |
| **F. Later** | She calls you. Camera perception. Ambient presence clip. Push. | — | reliability proven |

A alone removes every item in GAPS §5. B closes GAPS 1.3 and 1.4. E closes
GAPS 3.3. C and D are new, and they are where the thesis is actually tested.

## 10. Decisions needed

1. **Continuity rule.** 24 hours, as proposed — or always continue until the
   user starts fresh? 24 h keeps threads a sane size for eve and gives her a
   natural moment to open the day.
2. **Does she open every day, or only with content?** Proposed: only with
   content. It is the harder discipline and the one that keeps her from
   becoming a notification.
3. **Her profile route.** `/maya` — or a sheet over the stream so the user
   never leaves the conversation? `/maya` is proposed because it is linkable
   from emails.
4. **The brand inside the app.** Proposed: none beyond the window title.
   "Humanframe" is what you buy; Maya is who you work with.
5. **Captions during calls.** Not proposed for now — the call surface stays
   without a ticker — but it is an accessibility request that will come.
