import type { SupabaseClient } from "@supabase/supabase-js";

import { errorFields, logger } from "@/lib/logger";
import { loadAvailability } from "@/server/receptionist/availability";
import { normalizePhone, PROFILE_COLUMNS, profileFromRow, type BusinessProfile, type ProfileRow } from "@/server/receptionist/profile";
import { ensurePortal, portalUrl } from "@/server/receptionist/portal";
import { createUploadLink } from "@/server/receptionist/uploads";

import {
  canSubmit,
  collectedSchema,
  EMPTY_COLLECTED,
  formatTranscript,
  runTurn,
  type Collected,
  type WidgetMessage,
} from "./conversation";

/**
 * Widget conversations: start, talk, send.
 *
 * A conversation is a draft inquiry from its first moment, so photos the
 * customer attaches mid-chat land on the inquiry they belong to. Drafts are
 * invisible to the owner and to processing until the customer sends.
 */

export const MAX_TURNS = 30;
export const MAX_MESSAGE_CHARS = 2000;
const DAILY_SESSIONS_PER_WORKSPACE = 500;

export async function profileForWidget(admin: SupabaseClient, key: string): Promise<BusinessProfile | null> {
  if (!/^[0-9a-f]{20}$/.test(key)) return null;
  const { data } = await admin
    .from("business_profiles")
    .select(PROFILE_COLUMNS)
    .eq("widget_key", key)
    .maybeSingle<ProfileRow>();
  if (!data) return null;
  const profile = profileFromRow(data);
  return profile.widgetEnabled ? profile : null;
}

export function greetingFor(profile: BusinessProfile): string {
  if (profile.widgetGreeting.trim()) return profile.widgetGreeting.trim();
  return `Hei! Jeg hjelper deg å sende en forespørsel til ${profile.name || "oss"}. Hva kan vi hjelpe deg med?`;
}

export type StartedSession = { sessionId: string; uploadToken: string; greeting: string };

export async function startSession(
  admin: SupabaseClient,
  profile: BusinessProfile,
  origin: string | null
): Promise<StartedSession | { error: "busy" }> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await admin
    .from("widget_sessions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", profile.workspaceId)
    .gte("created_at", since);
  if ((count ?? 0) >= DAILY_SESSIONS_PER_WORKSPACE) return { error: "busy" };

  const greeting = greetingFor(profile);
  const { data: inquiry, error } = await admin
    .from("inquiries")
    .insert({
      workspace_id: profile.workspaceId,
      channel: "web",
      status: "draft",
      title: "Forespørsel fra nettsiden",
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !inquiry) {
    logger.error("widget.inquiry_insert_failed", errorFields(error));
    throw new Error("Could not start");
  }

  const messages: WidgetMessage[] = [{ role: "assistant", content: greeting, at: new Date().toISOString() }];
  const { data: session, error: sessionError } = await admin
    .from("widget_sessions")
    .insert({
      workspace_id: profile.workspaceId,
      inquiry_id: inquiry.id,
      messages,
      collected: EMPTY_COLLECTED,
      origin: origin?.slice(0, 300) ?? null,
    })
    .select("id")
    .single<{ id: string }>();
  if (sessionError || !session) throw new Error("Could not start");

  const uploadLink = await createUploadLink(admin, { workspaceId: profile.workspaceId, inquiryId: inquiry.id });
  return { sessionId: session.id, uploadToken: uploadLink.split("/u/")[1] ?? "", greeting };
}

type SessionRow = {
  id: string;
  workspace_id: string;
  inquiry_id: string;
  messages: WidgetMessage[];
  turns: number;
  status: "active" | "submitted" | "abandoned";
  collected: unknown;
};

async function loadSession(admin: SupabaseClient, profile: BusinessProfile, sessionId: string): Promise<SessionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const { data } = await admin
    .from("widget_sessions")
    .select("id, workspace_id, inquiry_id, messages, turns, status, collected")
    .eq("id", sessionId)
    .eq("workspace_id", profile.workspaceId)
    .maybeSingle<SessionRow>();
  return data;
}

async function photoCount(admin: SupabaseClient, inquiryId: string): Promise<number> {
  const { count } = await admin
    .from("inquiry_files")
    .select("id", { count: "exact", head: true })
    .eq("inquiry_id", inquiryId);
  return count ?? 0;
}

export type TurnResult =
  | { ok: true; reply: string; ready: boolean; canSubmit: boolean; suggestions: string[]; collected: Collected }
  | { ok: false; error: "not_found" | "closed" | "too_long" | "limit" | "failed" };

export async function takeTurn(
  admin: SupabaseClient,
  profile: BusinessProfile,
  sessionId: string,
  text: string
): Promise<TurnResult> {
  const content = text.trim();
  if (!content || content.length > MAX_MESSAGE_CHARS) return { ok: false, error: "too_long" };
  const session = await loadSession(admin, profile, sessionId);
  if (!session) return { ok: false, error: "not_found" };
  if (session.status !== "active") return { ok: false, error: "closed" };
  if (session.turns >= MAX_TURNS) return { ok: false, error: "limit" };

  const now = new Date();
  const messages: WidgetMessage[] = [...session.messages, { role: "user", content, at: now.toISOString() }];
  const collectedParsed = collectedSchema.safeParse(session.collected);
  const collected = collectedParsed.success ? collectedParsed.data : EMPTY_COLLECTED;

  try {
    const [availability, photos] = await Promise.all([
      profile.bookingEnabled
        ? loadAvailability(admin, profile, { now, calendarTimeoutMs: 3000, limit: 4 })
        : Promise.resolve({ slots: [] }),
      photoCount(admin, session.inquiry_id),
    ]);
    const turn = await runTurn({ profile, messages, collected, slots: availability.slots, photos, now });
    const nextCollected = mergeCollected(collected, turn.collected);
    messages.push({ role: "assistant", content: turn.reply, at: new Date().toISOString() });

    await admin
      .from("widget_sessions")
      .update({ messages, collected: nextCollected, turns: session.turns + 1 })
      .eq("id", session.id)
      .eq("turns", session.turns);

    return {
      ok: true,
      reply: turn.reply,
      ready: turn.ready,
      canSubmit: canSubmit(nextCollected),
      suggestions: turn.suggestions,
      collected: nextCollected,
    };
  } catch (error) {
    logger.error("widget.turn_failed", errorFields(error));
    return { ok: false, error: "failed" };
  }
}

/** Pure: a later turn may add facts but never erase one the customer gave. */
export function mergeCollected(previous: Collected, next: Collected): Collected {
  const pick = (a: string | null, b: string | null) => (b && b.trim() ? b.trim() : a);
  return {
    name: pick(previous.name, next.name),
    phone: pick(previous.phone, next.phone),
    email: pick(previous.email, next.email),
    address: pick(previous.address, next.address),
    job: pick(previous.job, next.job),
    when: pick(previous.when, next.when),
  };
}

export type SubmitResult =
  | { ok: true; inquiryId: string; portalUrl: string }
  | { ok: false; error: "not_found" | "closed" | "incomplete" };

export async function submitSession(
  admin: SupabaseClient,
  profile: BusinessProfile,
  sessionId: string,
  contact: Partial<Pick<Collected, "name" | "phone" | "email">>
): Promise<SubmitResult> {
  const session = await loadSession(admin, profile, sessionId);
  if (!session) return { ok: false, error: "not_found" };
  if (session.status !== "active") return { ok: false, error: "closed" };

  const parsed = collectedSchema.safeParse(session.collected);
  const collected = mergeCollected(parsed.success ? parsed.data : EMPTY_COLLECTED, {
    ...EMPTY_COLLECTED,
    name: contact.name ?? null,
    phone: contact.phone ?? null,
    email: contact.email ?? null,
  });
  if (!canSubmit(collected)) return { ok: false, error: "incomplete" };

  // Claim the conversation: a double tap sends once.
  const { data: claimed } = await admin
    .from("widget_sessions")
    .update({ status: "submitted", submitted_at: new Date().toISOString(), collected })
    .eq("id", session.id)
    .eq("status", "active")
    .select("id")
    .maybeSingle<{ id: string }>();
  if (!claimed) return { ok: false, error: "closed" };

  const photos = await photoCount(admin, session.inquiry_id);
  const email = collected.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(collected.email) ? collected.email.trim() : null;
  await admin
    .from("inquiries")
    .update({
      status: "open",
      caller_name: collected.name,
      caller_phone: collected.phone ? normalizePhone(collected.phone) : null,
      caller_email: email,
      title: collected.job?.slice(0, 200) ?? "Forespørsel fra nettsiden",
      transcript: formatTranscript(session.messages, photos),
      ended_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      processing: "pending",
    })
    .eq("id", session.inquiry_id)
    .eq("status", "draft");

  const token = await ensurePortal(admin, { workspaceId: profile.workspaceId, inquiryId: session.inquiry_id });
  return { ok: true, inquiryId: session.inquiry_id, portalUrl: portalUrl(token) };
}
