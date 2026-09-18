import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeftIcon, MessageCircleIcon, PhoneIcon, VideoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { RememberedFactRow } from "@/components/maya/remembered-fact";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { formatMessage, getLocale, getTranslations } from "@/lib/i18n";
import { formatDueDate, formatLongDate } from "@/lib/i18n/format";
import { getAssistantBySlug } from "@/server/db/repositories/assistants";
import { listUpcomingCommitments } from "@/server/db/repositories/commitments";
import { listRememberedFacts } from "@/server/db/repositories/memory";
import { requireRequestScope } from "@/server/db/request-scope";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.maya.profile.metaTitle };
}

const CONVERSATION = "/assistants/maya";

/**
 * Her profile — where the dashboard becomes a person.
 *
 * Commitments, memory, connectors and the AI disclosure all live here, framed
 * as what she is holding, what she remembers, what she can reach and how she
 * works. Nothing on this page is a module of its own.
 */
export default async function MayaProfilePage() {
  const scope = await requireRequestScope();
  const [t, locale, assistant] = await Promise.all([
    getTranslations(),
    getLocale(),
    getAssistantBySlug(scope.client, scope.workspaceId, "maya"),
  ]);
  if (!assistant) {
    redirect(CONVERSATION);
  }

  const [commitments, facts] = await Promise.all([
    listUpcomingCommitments(scope.client, scope.workspaceId, assistant.id),
    listRememberedFacts(scope.client, scope.workspaceId, assistant.id),
  ]);
  const copy = t.maya.profile;

  return (
    <div className="flex h-svh flex-col">
      <div className="flex h-16 shrink-0 items-center gap-1 px-3">
        <SidebarTrigger className="text-muted-foreground" />
        <Link
          href={CONVERSATION}
          className="text-muted-foreground hover:text-foreground flex h-8 items-center gap-1 rounded-lg pr-2.5 pl-1.5 text-[13px] font-medium transition-colors"
        >
          <ChevronLeftIcon className="size-4" />
          {copy.back}
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-16">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-9">
          <div className="flex flex-col items-center gap-4 pt-2 text-center">
            <Image
              src="/assistants/maya-avatar.png"
              alt=""
              width={128}
              height={128}
              priority
              className="size-32 rounded-full object-cover"
            />
            <div className="space-y-1">
              <h1 className="font-display text-3xl font-semibold tracking-tight">
                {assistant.name}
              </h1>
              <p className="text-[15px] leading-6">{t.maya.role}</p>
              <p className="text-muted-foreground text-[13px] leading-5">
                {formatMessage(copy.since, {
                  date: formatLongDate(assistant.createdAt, locale),
                })}
              </p>
            </div>
            <div className="flex items-center gap-2.5 pt-1">
              <Link
                href={`${CONVERSATION}?call=voice`}
                className="bg-call text-call-foreground hover:bg-call/80 flex h-9 items-center gap-2 rounded-full pr-4 pl-3.5 text-[13px] font-medium transition-colors"
              >
                <PhoneIcon className="size-4" />
                {t.maya.voiceCall}
              </Link>
              <Link
                href={`${CONVERSATION}?call=video`}
                className="bg-call text-call-foreground hover:bg-call/80 flex h-9 items-center gap-2 rounded-full pr-4 pl-3.5 text-[13px] font-medium transition-colors"
              >
                <VideoIcon className="size-4" />
                {t.maya.videoCall}
              </Link>
              <Link
                href={CONVERSATION}
                className="border-border hover:bg-muted flex h-9 items-center gap-2 rounded-full border pr-4 pl-3.5 text-[13px] font-medium transition-colors"
              >
                <MessageCircleIcon className="size-4" />
                {copy.write}
              </Link>
            </div>
          </div>

          <Section title={copy.holding}>
            {commitments.length === 0 ? (
              <Empty>{copy.holdingEmpty}</Empty>
            ) : (
              commitments.map((commitment) => (
                <Row key={commitment.id}>
                  <span className="text-muted-foreground w-24 shrink-0 tabular-nums">
                    {formatDueDate(commitment.dueAt, locale)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {commitment.title}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {copy.kinds[commitment.kind]}
                  </span>
                </Row>
              ))
            )}
          </Section>

          <Section title={copy.remember}>
            {facts.length === 0 ? (
              <Empty>{copy.rememberEmpty}</Empty>
            ) : (
              facts.map((fact) => <RememberedFactRow key={fact.id} fact={fact} />)
            )}
          </Section>

          <Section
            title={copy.reach}
            action={
              <Link
                href={`${CONVERSATION}?settings=connections`}
                className="text-muted-foreground hover:text-foreground text-[13px] font-medium transition-colors"
              >
                {copy.manageConnections}
              </Link>
            }
          >
            <Row>
              <span className="w-36 shrink-0">{copy.email}</span>
              <span className="text-muted-foreground min-w-0 flex-1">
                {copy.emailHint}
              </span>
            </Row>
            <Row>
              <span className="w-36 shrink-0">{copy.web}</span>
              <span className="text-muted-foreground min-w-0 flex-1">
                {copy.always}
              </span>
            </Row>
          </Section>

          <Section
            title={copy.how}
            action={
              <Link
                href={`${CONVERSATION}?settings=notifications`}
                className="text-muted-foreground hover:text-foreground text-[13px] font-medium transition-colors"
              >
                {copy.notifications}
              </Link>
            }
          >
            <p className="text-muted-foreground border-border/60 border-t py-3 text-sm leading-6">
              {copy.howText}
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <div className="flex items-baseline justify-between pb-2.5">
        <h2 className="font-display text-[17px] font-semibold tracking-tight">
          {title}
        </h2>
        {action}
      </div>
      <div className="border-border/60 flex flex-col border-b">{children}</div>
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div className="border-border/60 flex items-center gap-4 border-t py-3 text-sm">
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground border-border/60 border-t py-3 text-sm">
      {children}
    </p>
  );
}
