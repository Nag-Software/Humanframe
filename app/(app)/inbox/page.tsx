import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRightIcon, InboxIcon } from "lucide-react";

import { Page, PageHeader } from "@/components/hf/page";
import { EmptyState, Initials, Pill, Surface } from "@/components/hf/surface";
import { formatNok } from "@/components/hf/money";
import { CHANNEL_ICONS } from "@/components/receptionist/channel-icon";
import { formatInZone, formatPhone } from "@/components/receptionist/format";
import { formatMessage, getLocale, getTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { requireRequestScope } from "@/server/db/request-scope";
import { profileReadiness } from "@/server/receptionist/profile";
import { listQuotes } from "@/server/receptionist/quotes";
import { listActions, listInquiries, loadProfile, type Inquiry } from "@/server/receptionist/store";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.receptionist.inbox.metaTitle };
}

const FILTERS = ["open", "handled", "all"] as const;
type Filter = (typeof FILTERS)[number];

/**
 * Requests: everything that came in, newest first, with what each one is
 * waiting on. The screen the owner's alert links into, so it leads with
 * what needs a decision.
 */
export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const scope = await requireRequestScope();
  const params = await searchParams;
  const filter: Filter = FILTERS.includes(params.status as Filter) ? (params.status as Filter) : "open";

  const [t, locale, profile, inquiries, quotes] = await Promise.all([
    getTranslations(),
    getLocale(),
    loadProfile(scope.client, scope.workspaceId, scope.workspace.name),
    listInquiries(scope.client, scope.workspaceId, { status: filter, limit: 100 }),
    listQuotes(scope.client, scope.workspaceId, { limit: 200 }),
  ]);
  const actions = await listActions(scope.client, scope.workspaceId, inquiries.map((inquiry) => inquiry.id));
  const waitingBy = new Map<string, number>();
  for (const action of actions) {
    if (action.status === "proposed" || action.status === "failed") {
      waitingBy.set(action.inquiryId, (waitingBy.get(action.inquiryId) ?? 0) + 1);
    }
  }
  const quoteBy = new Map(quotes.map((quote) => [quote.inquiryId, quote]));
  const copy = t.receptionist.inbox;
  const ready = profileReadiness(profile).ready;
  const waitingTotal = [...waitingBy.values()].reduce((sum, count) => sum + count, 0);

  return (
    <Page>
      <PageHeader
        eyebrow={profile.name || scope.workspace.name}
        title={copy.title}
        description={copy.description}
      />

      {!ready ? (
        <Surface tone="fjord" className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <p className="font-serif text-2xl leading-tight">{copy.notReady}</p>
            <p className="text-fjord-foreground/70 mt-1 text-sm">{t.receptionist.setup.widgetDescription}</p>
          </div>
          <Link
            href="/setup"
            className="bg-fjord-foreground text-fjord flex h-10 items-center gap-1.5 rounded-xl px-4 text-sm font-semibold"
          >
            {copy.finishSetup}
            <ArrowUpRightIcon className="size-4" />
          </Link>
        </Surface>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="bg-secondary flex gap-0.5 rounded-xl p-1" aria-label={copy.title}>
          {FILTERS.map((value) => (
            <Link
              key={value}
              href={value === "open" ? "/inbox" : `/inbox?status=${value}`}
              className={cn(
                "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                value === filter ? "bg-card shadow-hairline text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {copy.filters[value]}
            </Link>
          ))}
        </nav>
        {waitingTotal > 0 ? (
          <Pill tone="fjord" dot>
            {formatMessage(copy.waiting, { count: waitingTotal })}
          </Pill>
        ) : null}
      </div>

      {inquiries.length === 0 ? (
        <EmptyState icon={<InboxIcon className="size-5" />} title={copy.title} body={copy.empty} />
      ) : (
        <Surface as="section" className="overflow-hidden">
          <ul className="divide-border divide-y">
            {inquiries.map((inquiry) => (
              <Row
                key={inquiry.id}
                inquiry={inquiry}
                waiting={waitingBy.get(inquiry.id) ?? 0}
                quoteTotal={quoteBy.get(inquiry.id)?.total ?? null}
                quoteStatus={quoteBy.get(inquiry.id)?.status ?? null}
                timeZone={profile.timezone}
                locale={locale}
                t={t}
              />
            ))}
          </ul>
        </Surface>
      )}
    </Page>
  );
}

function Row({
  inquiry,
  waiting,
  quoteTotal,
  quoteStatus,
  timeZone,
  locale,
  t,
}: {
  inquiry: Inquiry;
  waiting: number;
  quoteTotal: number | null;
  quoteStatus: string | null;
  timeZone: string;
  locale: Awaited<ReturnType<typeof getLocale>>;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  const copy = t.receptionist.inbox;
  const Icon = CHANNEL_ICONS[inquiry.channel];
  const who = inquiry.callerName ?? (formatPhone(inquiry.callerPhone) || inquiry.callerEmail || copy.hiddenNumber);
  const pending = inquiry.processing === "pending" || inquiry.processing === "processing";

  return (
    <li>
      <Link
        href={`/inbox/${inquiry.id}`}
        className="hover:bg-accent/50 flex items-center gap-4 px-5 py-4 transition-colors"
      >
        <span className="relative">
          <Initials name={who} />
          <span className="bg-card text-muted-foreground shadow-hairline absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full">
            <Icon className="size-3" aria-label={copy.channel[inquiry.channel]} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-[15px] font-medium">
              {pending ? copy.processing : inquiry.processing === "failed" ? copy.failed : inquiry.title || copy.channel[inquiry.channel]}
            </p>
            <span className="text-muted-foreground tabular shrink-0 text-xs">
              {formatInZone(inquiry.startedAt, timeZone, locale)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <p className="text-muted-foreground truncate text-sm">{who}</p>
            <div className="flex shrink-0 items-center gap-1.5">
              {inquiry.urgency === "high" ? <Pill tone="ember">{copy.urgent}</Pill> : null}
              {quoteTotal !== null ? (
                <Pill tone={quoteStatus === "accepted" ? "fjord" : "brass"}>
                  {formatNok(quoteTotal)}
                </Pill>
              ) : null}
              {waiting > 0 ? (
                <Pill tone="fjord" dot>
                  {formatMessage(copy.waiting, { count: waiting })}
                </Pill>
              ) : null}
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}
