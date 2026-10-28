import type { Metadata } from "next";

import { formatNok } from "@/components/hf/money";
import { Page, PageHeader, Section } from "@/components/hf/page";
import { EmptyState, Stat, Surface } from "@/components/hf/surface";
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
 * The report: requests, quotes and kroner, this week and every week before.
 * The headline is accepted value — the number that keeps a customer.
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
    <Page>
      <PageHeader eyebrow={profile.name || scope.workspace.name} title={copy.title} description={copy.description} />

      <Surface tone="ink" className="relative overflow-hidden p-7">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full opacity-25 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.75 0.1 80), transparent 65%)" }}
        />
        <p className="text-primary-foreground/60 text-[12px] font-medium tracking-[0.08em] uppercase">{copy.thisWeek}</p>
        <p className="font-serif tabular mt-3 text-[3.5rem] leading-none tracking-[-0.02em]">
          {formatNok(current.acceptedValue ?? 0)}
        </p>
        <p className="text-primary-foreground/70 mt-2 text-sm">{copy.acceptedValue}</p>
        <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
          <MiniStat label={copy.webRequests} value={current.webRequests ?? 0} />
          <MiniStat label={copy.quotesSent} value={current.quotesSent ?? 0} />
          <MiniStat label={copy.quotesAccepted} value={current.quotesAccepted ?? 0} />
          <MiniStat label={copy.quotedValue} value={formatNok(current.quotedValue ?? 0)} />
        </div>
      </Surface>

      <Section title={copy.title}>
        {(reports.data ?? []).length === 0 ? (
          <EmptyState title={copy.title} body={copy.empty} />
        ) : (
          <div className="flex flex-col gap-4">
            {(reports.data ?? []).map((report) => (
              <WeekCard
                key={report.id}
                title={formatMessage(copy.week, { week: weekNumber(report.week_start) })}
                stats={report.stats}
                copy={copy}
                footer={report.sent_to?.length ? formatMessage(copy.sentTo, { to: report.sent_to.join(", ") }) : null}
              />
            ))}
          </div>
        )}
      </Section>
    </Page>
  );
}

function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-primary-foreground/60 text-xs">{label}</p>
      <p className="font-serif tabular mt-1 text-2xl">{value}</p>
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
  const requests = (stats.webRequests ?? 0) + stats.answeredByAi + stats.voicemails + stats.smsInquiries;
  return (
    <Surface className="flex flex-col gap-5 p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {footer ? <span className="text-muted-foreground truncate text-xs">{footer}</span> : null}
      </div>
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label={copy.acceptedValue} value={formatNok(stats.acceptedValue ?? 0)} tone="brass" />
        <Stat label={copy.webRequests} value={requests} />
        <Stat label={copy.quotesSent} value={stats.quotesSent ?? 0} />
        <Stat label={copy.quotesAccepted} value={stats.quotesAccepted ?? 0} tone="fjord" />
      </div>
      {stats.calls > 0 ? (
        <p className="text-muted-foreground border-t pt-4 text-sm">
          {copy.calls}: {stats.calls} · {copy.answered}: {stats.answeredByAi} · {copy.voicemails}: {stats.voicemails} ·{" "}
          {copy.minutes}: {stats.minutes}
        </p>
      ) : null}
    </Surface>
  );
}
