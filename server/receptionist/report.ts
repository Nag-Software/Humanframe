import type { SupabaseClient } from "@supabase/supabase-js";

import { readEmailConfig, isAllowedRecipient, sendEmail } from "@/agent/lib/email";
import { appOrigin } from "@/agent/lib/email-template";
import { errorFields, logger } from "@/lib/logger";

import { workspaceOwnerEmails } from "./notify";
import type { BusinessProfile } from "./profile";
import { escapeHtml } from "./text";
import { addDays, localParts, zonedTime } from "./time";

/**
 * The weekly report: what the receptionist caught that the business would
 * otherwise have lost.
 *
 * Every call here was forwarded because nobody answered — that is how the
 * number is set up — so every answered call is one that would have gone to
 * voicemail or nowhere. The report says so in numbers the owner can check
 * against their own call log, and it is what keeps a customer paying.
 */

export type WeekStats = {
  weekStart: string;
  calls: number;
  answeredByAi: number;
  voicemails: number;
  silent: number;
  smsInquiries: number;
  bookings: number;
  smsSent: number;
  repliesSent: number;
  urgent: number;
  openNow: number;
  minutes: number;
  topTitles: string[];
};

export type ReportInquiry = {
  channel: "phone" | "voicemail" | "sms";
  status: "open" | "handled" | "dismissed";
  title: string;
  urgency: "low" | "normal" | "high";
  durationSeconds: number | null;
  transcript: string;
};

export type ReportAction = { kind: string; status: string };

/** Pure: the week's rows, counted. */
export function computeWeekStats(input: {
  weekStart: string;
  inquiries: ReportInquiry[];
  actions: ReportAction[];
  customerSmsSent: number;
}): WeekStats {
  const calls = input.inquiries.filter((row) => row.channel !== "sms");
  const silent = calls.filter((row) => !row.transcript.trim()).length;
  const done = (kind: string) =>
    input.actions.filter((action) => action.kind === kind && action.status === "done").length;

  return {
    weekStart: input.weekStart,
    calls: calls.length,
    answeredByAi: calls.filter((row) => row.channel === "phone" && row.transcript.trim()).length,
    voicemails: calls.filter((row) => row.channel === "voicemail" && row.transcript.trim()).length,
    silent,
    smsInquiries: input.inquiries.filter((row) => row.channel === "sms").length,
    bookings: done("booking"),
    smsSent: input.customerSmsSent,
    repliesSent: done("reply") + done("sms"),
    urgent: input.inquiries.filter((row) => row.urgency === "high").length,
    openNow: input.inquiries.filter((row) => row.status === "open").length,
    minutes: Math.round(calls.reduce((sum, row) => sum + (row.durationSeconds ?? 0), 0) / 60),
    topTitles: input.inquiries
      .filter((row) => row.title && row.status !== "dismissed")
      .map((row) => row.title)
      .slice(0, 5),
  };
}

/** The Monday that began the week before `now`, and the Monday after it. */
export function previousWeek(now: Date, timeZone: string): { start: Date; end: Date; label: string } {
  const today = localParts(now, timeZone);
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const sinceMonday = order.indexOf(today.weekday);
  const thisMonday = addDays(today, -sinceMonday);
  const lastMonday = addDays(thisMonday, -7);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    start: zonedTime(lastMonday, { hour: 0, minute: 0 }, timeZone),
    end: zonedTime(thisMonday, { hour: 0, minute: 0 }, timeZone),
    label: `${lastMonday.year}-${pad(lastMonday.month)}-${pad(lastMonday.day)}`,
  };
}

/** Pure: the email body. Plain words first; the numbers carry the argument. */
export function renderReport(stats: WeekStats, businessName: string): { subject: string; text: string; html: string } {
  const caught = stats.answeredByAi + stats.voicemails + stats.smsInquiries;
  const subject =
    caught > 0
      ? `${caught} henvendelser som ellers kunne gått tapt – uke ${weekNumber(stats.weekStart)}`
      : `Ukesrapport – uke ${weekNumber(stats.weekStart)}`;

  const lines = [
    `Uken som gikk for ${businessName || "bedriften"}:`,
    "",
    `${stats.calls} anrop ble satt over fordi ingen kunne svare.`,
    `${stats.answeredByAi} ble besvart av resepsjonisten, ${stats.voicemails} la igjen beskjed${stats.silent ? `, ${stats.silent} la på før noe ble sagt` : ""}.`,
    stats.smsInquiries ? `${stats.smsInquiries} henvendelser kom på SMS.` : null,
    `${stats.bookings} timer ble booket, og ${stats.repliesSent} svar ble sendt på SMS.`,
    stats.urgent ? `${stats.urgent} var merket som haster.` : null,
    stats.openNow ? `${stats.openNow} venter fortsatt på deg.` : "Ingenting venter på deg nå.",
    stats.topTitles.length ? "" : null,
    stats.topTitles.length ? "Noen av dem:" : null,
    ...stats.topTitles.map((title) => `- ${title}`),
  ].filter((line): line is string => line !== null);

  const url = `${appOrigin() ?? "http://localhost:3000"}/reports`;
  const text = [...lines, "", url].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<p style="font-size:28px;font-weight:600;margin:0 0 8px">${caught}</p>
<p style="margin:0 0 16px;color:#555">henvendelser som ellers kunne gått tapt</p>
${lines.map((line) => (line ? `<p style="margin:0 0 6px">${escapeHtml(line)}</p>` : "<br>")).join("\n")}
<p style="margin-top:16px"><a href="${escapeHtml(url)}">Se rapporten</a></p>
</div>`;
  return { subject, text, html };
}

export function weekNumber(isoDate: string): number {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

export async function buildWeekStats(
  admin: SupabaseClient,
  profile: BusinessProfile,
  week: { start: Date; end: Date; label: string }
): Promise<WeekStats> {
  const [{ data: inquiries }, { count: smsCount }] = await Promise.all([
    admin
      .from("inquiries")
      .select("id, channel, status, title, urgency, duration_seconds, transcript")
      .eq("workspace_id", profile.workspaceId)
      .gte("started_at", week.start.toISOString())
      .lt("started_at", week.end.toISOString())
      .order("started_at", { ascending: false })
      .returns<
        {
          id: string;
          channel: ReportInquiry["channel"];
          status: ReportInquiry["status"];
          title: string;
          urgency: ReportInquiry["urgency"];
          duration_seconds: number | null;
          transcript: string;
        }[]
      >(),
    admin
      .from("sms_messages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", profile.workspaceId)
      .eq("direction", "outbound")
      .eq("audience", "customer")
      .gte("created_at", week.start.toISOString())
      .lt("created_at", week.end.toISOString()),
  ]);

  const ids = (inquiries ?? []).map((row) => row.id);
  const { data: actions } = ids.length
    ? await admin.from("inquiry_actions").select("kind, status").in("inquiry_id", ids).returns<ReportAction[]>()
    : { data: [] as ReportAction[] };

  return computeWeekStats({
    weekStart: week.label,
    inquiries: (inquiries ?? []).map((row) => ({
      channel: row.channel,
      status: row.status,
      title: row.title,
      urgency: row.urgency,
      durationSeconds: row.duration_seconds,
      transcript: row.transcript,
    })),
    actions: actions ?? [],
    customerSmsSent: smsCount ?? 0,
  });
}

/**
 * Builds, stores and sends last week's report for one workspace. The unique
 * (workspace, week) row is the claim: a second run finds it and sends
 * nothing.
 */
export async function sendWeeklyReport(
  admin: SupabaseClient,
  profile: BusinessProfile,
  now = new Date()
): Promise<"sent" | "stored" | "exists" | "empty"> {
  const week = previousWeek(now, profile.timezone);
  const stats = await buildWeekStats(admin, profile, week);

  const { data: inserted, error } = await admin
    .from("weekly_reports")
    .insert({ workspace_id: profile.workspaceId, week_start: week.label, stats })
    .select("id")
    .maybeSingle<{ id: string }>();
  if (error?.code === "23505") return "exists";
  if (error || !inserted) {
    logger.error("report.insert_failed", errorFields(error));
    throw new Error("Could not store the weekly report");
  }

  if (stats.calls + stats.smsInquiries === 0) return "empty";

  const config = readEmailConfig();
  if (!config?.enabled) return "stored";
  const recipients = (await workspaceOwnerEmails(admin, profile.workspaceId)).filter((address) =>
    isAllowedRecipient(config, address)
  );
  const email = renderReport(stats, profile.name);
  const sentTo: string[] = [];
  for (const to of recipients) {
    const result = await sendEmail({
      config,
      payload: { to, ...email },
      idempotencyKey: `weekly-report/${profile.workspaceId}/${week.label}/${to}`,
    });
    if (result.kind === "sent" || result.kind === "duplicate") sentTo.push(to);
  }
  await admin
    .from("weekly_reports")
    .update({ sent_to: sentTo, sent_at: sentTo.length ? new Date().toISOString() : null })
    .eq("id", inserted.id);
  return sentTo.length ? "sent" : "stored";
}
