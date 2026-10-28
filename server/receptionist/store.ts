import type { SupabaseClient } from "@supabase/supabase-js";

import { errorFields, logger } from "@/lib/logger";

import {
  emptyProfile,
  PROFILE_COLUMNS,
  profileFromRow,
  profileToRow,
  type BusinessProfile,
  type ProfileInput,
  type ProfileRow,
} from "./profile";

/**
 * Reads and writes for the receptionist's tables.
 *
 * Every function takes the client it should use. A request handler passes the
 * user's own client, so row level security applies; a webhook passes the
 * service role, after it has proved which workspace the event belongs to.
 */

export async function loadProfile(
  client: SupabaseClient,
  workspaceId: string,
  fallbackName = ""
): Promise<BusinessProfile> {
  const { data } = await client
    .from("business_profiles")
    .select(PROFILE_COLUMNS)
    .eq("workspace_id", workspaceId)
    .maybeSingle<ProfileRow>();
  return data ? profileFromRow(data) : emptyProfile(workspaceId, fallbackName);
}

export async function saveProfile(
  client: SupabaseClient,
  workspaceId: string,
  input: ProfileInput,
  extra: { learnedFrom?: string[]; learnedAt?: string; onboarded?: boolean } = {}
): Promise<BusinessProfile> {
  const row: Record<string, unknown> = {
    workspace_id: workspaceId,
    ...profileToRow(input),
  };
  if (extra.learnedFrom) row.learned_from = extra.learnedFrom;
  if (extra.learnedAt) row.learned_at = extra.learnedAt;
  if (extra.onboarded) row.onboarded_at = new Date().toISOString();

  const { data, error } = await client
    .from("business_profiles")
    .upsert(row, { onConflict: "workspace_id" })
    .select(PROFILE_COLUMNS)
    .single<ProfileRow>();

  if (error || !data) {
    logger.error("receptionist.profile_save_failed", errorFields(error));
    throw new Error("Could not save the business profile");
  }
  return profileFromRow(data);
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

export type PhoneNumber = {
  id: string;
  workspaceId: string;
  e164: string;
  providerSid: string | null;
  forwardedFrom: string | null;
  status: "active" | "released";
};

type PhoneNumberRow = {
  id: string;
  workspace_id: string;
  e164: string;
  provider_sid: string | null;
  forwarded_from: string | null;
  status: "active" | "released";
};

const PHONE_COLUMNS = "id, workspace_id, e164, provider_sid, forwarded_from, status";

function toPhoneNumber(row: PhoneNumberRow): PhoneNumber {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    e164: row.e164,
    providerSid: row.provider_sid,
    forwardedFrom: row.forwarded_from,
    status: row.status,
  };
}

export async function listPhoneNumbers(
  client: SupabaseClient,
  workspaceId: string
): Promise<PhoneNumber[]> {
  const { data } = await client
    .from("phone_numbers")
    .select(PHONE_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .returns<PhoneNumberRow[]>();
  return (data ?? []).map(toPhoneNumber);
}

/** The workspace an incoming call or SMS belongs to: by the number dialled. */
export async function findPhoneNumber(
  admin: SupabaseClient,
  e164: string
): Promise<PhoneNumber | null> {
  const { data } = await admin
    .from("phone_numbers")
    .select(PHONE_COLUMNS)
    .eq("e164", e164)
    .eq("status", "active")
    .maybeSingle<PhoneNumberRow>();
  return data ? toPhoneNumber(data) : null;
}

export async function insertPhoneNumber(
  admin: SupabaseClient,
  input: { workspaceId: string; e164: string; providerSid: string | null; forwardedFrom?: string | null }
): Promise<PhoneNumber> {
  const { data, error } = await admin
    .from("phone_numbers")
    .insert({
      workspace_id: input.workspaceId,
      e164: input.e164,
      provider_sid: input.providerSid,
      forwarded_from: input.forwardedFrom ?? null,
    })
    .select(PHONE_COLUMNS)
    .single<PhoneNumberRow>();
  if (error || !data) {
    logger.error("receptionist.number_insert_failed", errorFields(error));
    throw new Error("Could not save the phone number");
  }
  return toPhoneNumber(data);
}

// ---------------------------------------------------------------------------
// Inquiries
// ---------------------------------------------------------------------------

export type InquiryChannel = "phone" | "voicemail" | "sms";
export type InquiryStatus = "open" | "handled" | "dismissed";

export type Inquiry = {
  id: string;
  workspaceId: string;
  channel: InquiryChannel;
  status: InquiryStatus;
  callerPhone: string | null;
  callerName: string | null;
  callerEmail: string | null;
  title: string;
  summary: string;
  intake: Record<string, unknown>;
  urgency: "low" | "normal" | "high";
  transcript: string;
  processing: "pending" | "processing" | "done" | "failed" | "skipped";
  processingError: string | null;
  callSid: string | null;
  recordingSid: string | null;
  recordingUrl: string | null;
  recordingChannels: number | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  ownerNotifiedAt: string | null;
};

export type InquiryRow = {
  id: string;
  workspace_id: string;
  channel: InquiryChannel;
  status: InquiryStatus;
  caller_phone: string | null;
  caller_name: string | null;
  caller_email: string | null;
  title: string;
  summary: string;
  intake: Record<string, unknown> | null;
  urgency: "low" | "normal" | "high";
  transcript: string;
  processing: Inquiry["processing"];
  processing_error: string | null;
  call_sid: string | null;
  recording_sid: string | null;
  recording_url: string | null;
  recording_channels: number | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  owner_notified_at: string | null;
};

export const INQUIRY_COLUMNS =
  "id, workspace_id, channel, status, caller_phone, caller_name, caller_email, " +
  "title, summary, intake, urgency, transcript, processing, processing_error, " +
  "call_sid, recording_sid, recording_url, recording_channels, started_at, " +
  "answered_at, ended_at, duration_seconds, owner_notified_at";

export function toInquiry(row: InquiryRow): Inquiry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channel: row.channel,
    status: row.status,
    callerPhone: row.caller_phone,
    callerName: row.caller_name,
    callerEmail: row.caller_email,
    title: row.title,
    summary: row.summary,
    intake: row.intake ?? {},
    urgency: row.urgency,
    transcript: row.transcript,
    processing: row.processing,
    processingError: row.processing_error,
    callSid: row.call_sid,
    recordingSid: row.recording_sid,
    recordingUrl: row.recording_url,
    recordingChannels: row.recording_channels,
    startedAt: row.started_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    ownerNotifiedAt: row.owner_notified_at,
  };
}

export async function getInquiry(
  client: SupabaseClient,
  id: string,
  workspaceId?: string
): Promise<Inquiry | null> {
  let query = client.from("inquiries").select(INQUIRY_COLUMNS).eq("id", id);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  const { data } = await query.maybeSingle<InquiryRow>();
  return data ? toInquiry(data) : null;
}

export async function getInquiryByCallSid(
  admin: SupabaseClient,
  callSid: string
): Promise<Inquiry | null> {
  const { data } = await admin
    .from("inquiries")
    .select(INQUIRY_COLUMNS)
    .eq("call_sid", callSid)
    .maybeSingle<InquiryRow>();
  return data ? toInquiry(data) : null;
}

export async function listInquiries(
  client: SupabaseClient,
  workspaceId: string,
  options: { status?: InquiryStatus | "all"; limit?: number } = {}
): Promise<Inquiry[]> {
  let query = client
    .from("inquiries")
    .select(INQUIRY_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false })
    .limit(options.limit ?? 50);
  if (options.status && options.status !== "all") {
    query = query.eq("status", options.status);
  }
  const { data } = await query.returns<InquiryRow[]>();
  return (data ?? []).map(toInquiry);
}

/** What the business already knows about a caller: their earlier inquiries. */
export async function callerHistory(
  admin: SupabaseClient,
  workspaceId: string,
  callerPhone: string,
  excludeId?: string
): Promise<Pick<Inquiry, "id" | "callerName" | "title" | "summary" | "startedAt">[]> {
  let query = admin
    .from("inquiries")
    .select("id, caller_name, title, summary, started_at")
    .eq("workspace_id", workspaceId)
    .eq("caller_phone", callerPhone)
    .eq("processing", "done")
    .order("started_at", { ascending: false })
    .limit(5);
  if (excludeId) query = query.neq("id", excludeId);
  const { data } = await query.returns<
    { id: string; caller_name: string | null; title: string; summary: string; started_at: string }[]
  >();
  return (data ?? []).map((row) => ({
    id: row.id,
    callerName: row.caller_name,
    title: row.title,
    summary: row.summary,
    startedAt: row.started_at,
  }));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ActionKind = "booking" | "sms" | "reply" | "callback";
export type ActionStatus =
  | "proposed"
  | "approved"
  | "executing"
  | "done"
  | "failed"
  | "unknown"
  | "dismissed";

export type InquiryAction = {
  id: string;
  workspaceId: string;
  inquiryId: string;
  kind: ActionKind;
  status: ActionStatus;
  payload: Record<string, unknown>;
  rationale: string;
  result: Record<string, unknown> | null;
  error: string | null;
  decidedAt: string | null;
  executedAt: string | null;
  createdAt: string;
};

type ActionRow = {
  id: string;
  workspace_id: string;
  inquiry_id: string;
  kind: ActionKind;
  status: ActionStatus;
  payload: Record<string, unknown>;
  rationale: string;
  result: Record<string, unknown> | null;
  error: string | null;
  decided_at: string | null;
  executed_at: string | null;
  created_at: string;
};

export const ACTION_COLUMNS =
  "id, workspace_id, inquiry_id, kind, status, payload, rationale, result, " +
  "error, decided_at, executed_at, created_at";

export function toAction(row: ActionRow): InquiryAction {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    inquiryId: row.inquiry_id,
    kind: row.kind,
    status: row.status,
    payload: row.payload,
    rationale: row.rationale,
    result: row.result,
    error: row.error,
    decidedAt: row.decided_at,
    executedAt: row.executed_at,
    createdAt: row.created_at,
  };
}

export async function listActions(
  client: SupabaseClient,
  workspaceId: string,
  inquiryIds: string[]
): Promise<InquiryAction[]> {
  if (inquiryIds.length === 0) return [];
  const { data } = await client
    .from("inquiry_actions")
    .select(ACTION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .in("inquiry_id", inquiryIds)
    .order("created_at", { ascending: true })
    .returns<ActionRow[]>();
  return (data ?? []).map(toAction);
}

export async function getAction(
  client: SupabaseClient,
  id: string,
  workspaceId: string
): Promise<InquiryAction | null> {
  const { data } = await client
    .from("inquiry_actions")
    .select(ACTION_COLUMNS)
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle<ActionRow>();
  return data ? toAction(data) : null;
}

/**
 * Moves an action from one status to the next, only if it is still in the
 * status the caller saw. Returns the updated row, or null if someone — a
 * second tap, a second tab — got there first.
 */
export async function transitionAction(
  admin: SupabaseClient,
  input: {
    id: string;
    workspaceId: string;
    from: ActionStatus | ActionStatus[];
    to: ActionStatus;
    patch?: Record<string, unknown>;
  }
): Promise<InquiryAction | null> {
  const from = Array.isArray(input.from) ? input.from : [input.from];
  const { data } = await admin
    .from("inquiry_actions")
    .update({ status: input.to, ...(input.patch ?? {}) })
    .eq("id", input.id)
    .eq("workspace_id", input.workspaceId)
    .in("status", from)
    .select(ACTION_COLUMNS)
    .maybeSingle<ActionRow>();
  return data ? toAction(data) : null;
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export type Booking = {
  id: string;
  workspaceId: string;
  inquiryId: string | null;
  startsAt: string;
  endsAt: string;
  title: string;
  customerName: string;
  customerPhone: string | null;
  address: string;
  notes: string;
  status: "confirmed" | "cancelled";
  calendarProvider: string | null;
  calendarEventId: string | null;
  calendarError: string | null;
};

type BookingRow = {
  id: string;
  workspace_id: string;
  inquiry_id: string | null;
  starts_at: string;
  ends_at: string;
  title: string;
  customer_name: string;
  customer_phone: string | null;
  address: string;
  notes: string;
  status: "confirmed" | "cancelled";
  calendar_provider: string | null;
  calendar_event_id: string | null;
  calendar_error: string | null;
};

export const BOOKING_COLUMNS =
  "id, workspace_id, inquiry_id, starts_at, ends_at, title, customer_name, " +
  "customer_phone, address, notes, status, calendar_provider, calendar_event_id, calendar_error";

export function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    inquiryId: row.inquiry_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    title: row.title,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    address: row.address,
    notes: row.notes,
    status: row.status,
    calendarProvider: row.calendar_provider,
    calendarEventId: row.calendar_event_id,
    calendarError: row.calendar_error,
  };
}

export async function listBookings(
  client: SupabaseClient,
  workspaceId: string,
  range: { from: Date; to: Date }
): Promise<Booking[]> {
  const { data } = await client
    .from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("status", "confirmed")
    .lt("starts_at", range.to.toISOString())
    .gt("ends_at", range.from.toISOString())
    .order("starts_at", { ascending: true })
    .returns<BookingRow[]>();
  return (data ?? []).map(toBooking);
}
