import type { Metadata } from "next";
import Link from "next/link";
import { CHANNEL_ICONS } from "@/components/receptionist/channel-icon";
import { formatInZone, formatPhone } from "@/components/receptionist/format";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { formatMessage, getLocale, getTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { requireRequestScope } from "@/server/db/request-scope";
import { profileReadiness } from "@/server/receptionist/profile";
import {
  listActions,
  listInquiries,
  listPhoneNumbers,
  loadProfile,
  type Inquiry,
} from "@/server/receptionist/store";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.receptionist.inbox.metaTitle };
}

const FILTERS = ["open", "handled", "all"] as const;
type Filter = (typeof FILTERS)[number];

/**
 * The inbox: every call, voicemail and text the receptionist took, newest
 * first, with how many proposals each is waiting on. This is the screen the
 * owner's SMS links into.
 */
export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const scope = await requireRequestScope();
  const params = await searchParams;
  const filter: Filter = FILTERS.includes(params.status as Filter) ? (params.status as Filter) : "open";

  const [t, locale, profile, numbers, inquiries] = await Promise.all([
    getTranslations(),
    getLocale(),
    loadProfile(scope.client, scope.workspaceId, scope.workspace.name),
    listPhoneNumbers(scope.client, scope.workspaceId),
    listInquiries(scope.client, scope.workspaceId, { status: filter, limit: 100 }),
  ]);
  const actions = await listActions(
    scope.client,
    scope.workspaceId,
    inquiries.map((inquiry) => inquiry.id)
  );
  const waitingBy = new Map<string, number>();
  for (const action of actions) {
    if (action.status === "proposed" || action.status === "failed") {
      waitingBy.set(action.inquiryId, (waitingBy.get(action.inquiryId) ?? 0) + 1);
    }
  }

  const copy = t.receptionist.inbox;
  const ready = profileReadiness(profile).ready && numbers.length > 0;

  return (
    <div className="flex h-svh flex-col">
      <div className="flex h-16 shrink-0 items-center gap-1 px-3">
        <SidebarTrigger className="text-muted-foreground" />
        <h1 className="font-display px-1.5 text-base font-semibold tracking-tight">{copy.title}</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-16">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
          <p className="text-muted-foreground text-sm">{copy.description}</p>

          {!ready ? (
            <div className="border-border/60 bg-muted/40 flex items-center justify-between gap-4 rounded-xl border p-4">
              <p className="text-sm">{copy.notReady}</p>
              <Link
                href="/setup"
                className="bg-primary text-primary-foreground rounded-lg px-3 py-1.5 text-sm font-medium"
              >
                {copy.finishSetup}
              </Link>
            </div>
          ) : null}

          <nav className="bg-muted/60 flex w-fit gap-0.5 rounded-lg p-0.5" aria-label={copy.title}>
            {FILTERS.map((value) => (
              <Link
                key={value}
                href={value === "open" ? "/inbox" : `/inbox?status=${value}`}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium",
                  value === filter ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                )}
              >
                {copy.filters[value]}
              </Link>
            ))}
          </nav>

          {inquiries.length === 0 ? (
            <p className="text-muted-foreground border-border/60 border-t py-3 text-sm">{copy.empty}</p>
          ) : (
            <ul className="divide-border/60 border-border/60 divide-y border-t">
              {inquiries.map((inquiry) => (
                <InquiryRow
                  key={inquiry.id}
                  inquiry={inquiry}
                  waiting={waitingBy.get(inquiry.id) ?? 0}
                  timeZone={profile.timezone}
                  locale={locale}
                  copy={copy}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function InquiryRow({
  inquiry,
  waiting,
  timeZone,
  locale,
  copy,
}: {
  inquiry: Inquiry;
  waiting: number;
  timeZone: string;
  locale: Awaited<ReturnType<typeof getLocale>>;
  copy: Awaited<ReturnType<typeof getTranslations>>["receptionist"]["inbox"];
}) {
  const Icon = CHANNEL_ICONS[inquiry.channel];
  const who = inquiry.callerName ?? (formatPhone(inquiry.callerPhone) || copy.hiddenNumber);
  const pending = inquiry.processing === "pending" || inquiry.processing === "processing";

  return (
    <li>
      <Link
        href={`/inbox/${inquiry.id}`}
        className="hover:bg-muted/40 -mx-2 flex items-start gap-3 rounded-lg px-2 py-3 transition-colors"
      >
        <span className="bg-muted text-muted-foreground mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full">
          <Icon className="size-4" aria-label={copy.channel[inquiry.channel]} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-sm font-medium">{who}</p>
            <span className="text-muted-foreground shrink-0 text-xs">
              {formatInZone(inquiry.startedAt, timeZone, locale)}
            </span>
          </div>
          <p className="text-muted-foreground truncate text-sm">
            {pending ? copy.processing : inquiry.processing === "failed" ? copy.failed : inquiry.title}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5 empty:hidden">
            {inquiry.urgency === "high" ? <Badge variant="destructive">{copy.urgent}</Badge> : null}
            {waiting > 0 ? (
              <Badge variant="secondary">{formatMessage(copy.waiting, { count: waiting })}</Badge>
            ) : null}
          </div>
        </div>
      </Link>
    </li>
  );
}
