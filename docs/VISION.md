# Humanframe — Product Vision and MVP Plan

## Vision

Humanframe is an operating system for digital employees.

The product should make interacting with AI feel like working with a real colleague, not operating software. Digital employees have a face, voice, personality, role, memory and access to the tools required to perform useful work.

Humanframe is an international, English-first B2B SaaS product. Its core positioning is:

“AI that feels like a real colleague.”

The first digital employee is Maya, a Chief of Staff who communicates naturally, remembers the user and helps manage everyday work.

## The MVP

The MVP should do one thing exceptionally well: let the user communicate and collaborate with Maya.

The interface has only three primary experiences:

1. Chat with Maya
2. Voice call with Maya
3. Face-to-face video call with Maya

Do not build a traditional SaaS dashboard. Calendar, tasks, memory, tools and workflows should not become separate primary modules. Maya accesses these capabilities in the background and presents results naturally inside the conversation.

The ideal experience is:

“Open Humanframe. Talk to Maya. She handles the rest.”

## Maya’s capabilities

Maya can communicate through streamed text, natural speech, voice messages and realistic video. She remembers previous conversations, user preferences, people, companies and important events.

She can search the web, read and create files, understand images, draft emails, inspect calendars and prepare actions through connected services.

Responses can contain more than text, including images, files, website previews, sources, email drafts, calendar events, progress states and approval cards.

Maya may perform safe, reversible actions independently. Consequential external actions—such as sending emails, creating appointments or contacting people—must require explicit approval during the MVP.

## User experience

Humanframe should feel like a premium native macOS communication app, combining the simplicity of Claude and ChatGPT with the familiarity of FaceTime.

The design should be calm, minimal and spacious. Use system-like typography, subtle separators, restrained colors and almost no decorative cards or gradients.

The default screen is the conversation with Maya. The header shows her name, role, online status, voice-call button and video-call button. The composer supports text, images, files, pasted content and voice input.

Voice calls transition into a minimal call interface. Video calls place Maya at the center, with discreet FaceTime-style controls that disappear when inactive.

Technical details such as tool calls, database operations and raw JSON must remain hidden. Show human-readable states such as “Searching the web”, “Checking your calendar” or “Preparing a reply”.

## Technical foundation

Use Next.js, TypeScript, Supabase and Vercel.

Use assistant-ui for the chat runtime and interface, with Vercel AI SDK connecting the frontend to the model and tool layer. Use OpenAI for intelligence, speech and realtime voice. Use Tavus for Maya’s realtime video avatar.

Use Supabase Auth for accounts, Postgres for application data, Supabase Storage for files and pgvector for semantic long-term memory.

Store messages as structured content parts instead of flattening everything into text. Preserve attachments, sources, tool calls, results and approval states.

The architecture must separate:

- conversation and UI
- model orchestration
- tools and connectors
- memory retrieval and storage
- voice sessions
- Tavus video sessions
- approval and audit logic

This separation should allow providers to be replaced later without rebuilding the product.

## Memory

Maya’s memory should combine recent conversation context, structured user facts and vector-based semantic retrieval.

Do not store every message as permanent memory. Extract useful facts, preferences, relationships, decisions and ongoing projects. Store the original source, timestamp and confidence so memories can be inspected, corrected or deleted later.

Before generating a response, retrieve only memories relevant to the current conversation.

## Initial connectors

The first useful integrations are:

- Web search
- Gmail or Outlook email
- Google Calendar or Outlook Calendar
- File upload and generation

Connector complexity should remain outside the main experience. Users connect accounts through Settings, then simply ask Maya to use them.

## MVP scope control

The MVP includes one digital employee, one user, English language, chat, voice, video, memory, web search, files and a small number of connectors.

Do not build teams, multiple employee roles, workflow builders, marketplaces, complex dashboards, mobile apps or advanced analytics yet.

Build the narrowest product that proves users want to communicate with and delegate real work to a humanlike digital employee.

## Product principles

Maya must feel human, but Humanframe must always disclose that she is AI.

Every interaction should be understandable, interruptible and controllable. Users must know when Maya is thinking, searching, waiting for approval or acting externally.

Human realism creates attention. Reliable work, memory and trust create retention.

The MVP succeeds when users return to Maya because speaking with her is the simplest way to get work done.
