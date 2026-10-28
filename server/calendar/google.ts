import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { executeProviderTool } from "@/server/connectors/composio";

import type { Interval } from "@/server/receptionist/slots";
import { localParts } from "@/server/receptionist/time";

/**
 * The business's Google Calendar, through Composio.
 *
 * Two operations: read busy time so the receptionist offers real slots, and
 * write an event once the owner approves a booking. The tool slugs and pinned
 * versions come from the action register (`connector_actions`), so a
 * provider rename or a toolkit change is a row update, and an unpinned
 * version fails closed exactly as it does for email.
 *
 * Composio's response shapes for these tools vary between toolkit versions,
 * so both readers below look for the data rather than assume one path to it.
 */

export type CalendarAccount = {
  accountId: string;
  composioUserId: string;
  connectedAccountId: string;
  email: string | null;
};

type RegisterRow = { tool_slug: string; tool_version: string };

export async function findCalendarAccount(
  admin: SupabaseClient,
  workspaceId: string
): Promise<CalendarAccount | null> {
  const { data } = await admin
    .from("connector_accounts")
    .select("id, composio_user_id, connected_account_id, account_email")
    .eq("workspace_id", workspaceId)
    .eq("provider", "googlecalendar")
    .eq("status", "active")
    .not("connected_account_id", "is", null)
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string;
      composio_user_id: string;
      connected_account_id: string;
      account_email: string | null;
    }>();
  return data
    ? {
        accountId: data.id,
        composioUserId: data.composio_user_id,
        connectedAccountId: data.connected_account_id,
        email: data.account_email,
      }
    : null;
}

async function registerEntry(
  admin: SupabaseClient,
  actionKey: "calendar.busy" | "calendar.create"
): Promise<RegisterRow | null> {
  const { data } = await admin
    .from("connector_actions")
    .select("tool_slug, tool_version")
    .eq("provider", "googlecalendar")
    .eq("action_key", actionKey)
    .eq("enabled", true)
    .maybeSingle<RegisterRow>();
  return data;
}

/** Google wants local wall time plus a zone name, not an offset. */
export function localIso(date: Date, timeZone: string): string {
  const parts = localParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:00`;
}

/**
 * Every `{ start, end }` pair anywhere in the response. Free/busy answers
 * nest them under `calendars.primary.busy`, sometimes inside `data` or
 * `response_data`; walking the tree is sturdier than naming one path.
 */
export function extractBusy(value: unknown, depth = 0): Interval[] {
  if (depth > 6 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractBusy(item, depth + 1));

  const record = value as Record<string, unknown>;
  const start = record.start ?? record.start_time;
  const end = record.end ?? record.end_time;
  const read = (input: unknown): Date | null => {
    const text =
      typeof input === "string"
        ? input
        : input && typeof input === "object"
          ? ((input as { dateTime?: string }).dateTime ?? null)
          : null;
    if (!text) return null;
    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? date : null;
  };

  const startDate = read(start);
  const endDate = read(end);
  if (startDate && endDate && endDate > startDate) {
    return [{ start: startDate, end: endDate }];
  }

  // A free-slot answer lists free time too; only walk the busy side of it.
  return Object.entries(record)
    .filter(([key]) => !/^free/i.test(key))
    .flatMap(([, child]) => extractBusy(child, depth + 1));
}

export function extractEventId(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && (record.htmlLink || record.iCalUID || record.status || depth > 0)) {
    return record.id;
  }
  for (const key of ["data", "response_data", "event", "response"]) {
    const found = extractEventId(record[key], depth + 1);
    if (found) return found;
  }
  return typeof record.id === "string" ? record.id : null;
}

export async function readBusy(
  admin: SupabaseClient,
  account: CalendarAccount,
  range: { from: Date; to: Date; timeZone: string }
): Promise<Interval[]> {
  const entry = await registerEntry(admin, "calendar.busy");
  if (!entry) throw new Error("calendar.busy is not enabled in the register");

  const data = await executeProviderTool({
    composioUserId: account.composioUserId,
    connectedAccountId: account.connectedAccountId,
    slug: entry.tool_slug,
    version: entry.tool_version,
    args: {
      time_min: range.from.toISOString(),
      time_max: range.to.toISOString(),
      timezone: range.timeZone,
      items: ["primary"],
    },
  });
  return extractBusy(data);
}

export async function createCalendarEvent(
  admin: SupabaseClient,
  account: CalendarAccount,
  event: {
    start: Date;
    end: Date;
    timeZone: string;
    summary: string;
    description: string;
    location: string;
  }
): Promise<string | null> {
  const entry = await registerEntry(admin, "calendar.create");
  if (!entry) throw new Error("calendar.create is not enabled in the register");

  const minutes = Math.max(1, Math.round((event.end.getTime() - event.start.getTime()) / 60_000));
  const data = await executeProviderTool({
    composioUserId: account.composioUserId,
    connectedAccountId: account.connectedAccountId,
    slug: entry.tool_slug,
    version: entry.tool_version,
    args: {
      calendar_id: "primary",
      start_datetime: localIso(event.start, event.timeZone),
      timezone: event.timeZone,
      event_duration_hour: Math.floor(minutes / 60),
      event_duration_minutes: minutes % 60,
      summary: event.summary,
      description: event.description,
      location: event.location,
    },
  });
  const id = extractEventId(data);
  if (!id) logger.warn("calendar.create_no_id", {});
  return id;
}
