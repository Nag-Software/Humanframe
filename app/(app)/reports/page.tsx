import type { Metadata } from "next";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { formatMessage, getTranslations } from "@/lib/i18n";
import { requireRequestScope } from "@/server/db/request-scope";
import { buildWeekStats, weekNumber, type WeekStats } from "@/server/receptionist/report";
import { loadProfile } from "@/server/receptionist/store";
import { addDays, localParts, zonedTime } from "@/server/receptionist/time";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.receptionist.reports.metaTitle };
}

/**
 * The weekly reports, newest first, with the week in progress on top. The
 * headline number is the one that keeps a customer: inquiries that would
 * otherwise have gone unanswered.
 */
export default async function ReportsPage() {
  const scope = await requireRequestScope();
  const [t, profile, reports] = await Promise.all([
    getTranslations(),
    loadProfile(scope.client, scope.workspaceId),
    scope.client
      .from("weekly_reports")
      .select("id, week_start, stats, sent_to")
      .eq("workspace_id", scope.workspaceId)
      .order("week_start", { ascending: false })
      .limit(26)
      .returns<{ id: string; week_start: string; stats: WeekStats; sent_to: string[] | null }[]>(),
  ]);

  // This week so far: Monday 00:00 local until now. Read with the user's own
  // client, so it can only ever count their own workspace.
  const now = new Date();
  const today = localParts(now, profile.timezone);
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const monday = addDays(today, -order.indexOf(today.weekday));
  const pad = (value: number) => String(value).padStart(2, "0");
  const current = await buildWeekStats(scope.client, profile, {
    start: zonedTime(monday, { hour: 0, minute: 0 }, profile.timezone),
    end: now,
    label: `${monday.year}-${pad(monday.month)}-${pad(monday.day)}`,
  });

  const copy = t.receptionist.reports;

  return (
    <div className="flex h-svh flex-col">
      <div className="flex h-16 shrink-0 items-center gap-1 px-3">
        <SidebarTrigger className="text-muted-foreground" />
        <h1 className="font-display px-1.5 text-base font-semibold tracking-tight">{copy.title}</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-16">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8">
          <p className="text-muted-foreground text-sm">{copy.description}</p>

          <WeekCard title={copy.thisWeek} stats={current} copy={copy} />

          {(reports.data ?? []).length === 0 ? (
            <p className="text-muted-foreground border-border/60 border-t py-3 text-sm">{copy.empty}</p>
          ) : (
            (reports.data ?? []).map((report) => (
              <WeekCard
                key={report.id}
                title={formatMessage(copy.week, { week: weekNumber(report.week_start) })}
                stats={report.stats}
                copy={copy}
                footer={report.sent_to?.length ? formatMessage(copy.sentTo, { to: report.sent_to.join(", ") }) : null}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function WeekCard({
  title,
  stats,
  copy,
  footer,
}: {
  title: string;
  stats: WeekStats;
  copy: Awaited<ReturnType<typeof getTranslations>>["receptionist"]["reports"];
  footer?: string | null;
}) {
  const caught = stats.answeredByAi + stats.voicemails + stats.smsInquiries;
  const rows: [string, number][] = [
    [copy.calls, stats.calls],
    [copy.answered, stats.answeredByAi],
    [copy.voicemails, stats.voicemails],
    [copy.silent, stats.silent],
    [copy.sms, stats.smsInquiries],
    [copy.bookings, stats.bookings],
    [copy.replies, stats.repliesSent],
    [copy.minutes, stats.minutes],
  ];
  return (
    <section className="border-border/60 flex flex-col gap-4 rounded-xl border p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      <div>
        <p className="font-display text-4xl font-semibold tracking-tight">{caught}</p>
        <p className="text-muted-foreground text-sm">{copy.caught}</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {footer ? <p className="text-muted-foreground text-xs">{footer}</p> : null}
    </section>
  );
}
