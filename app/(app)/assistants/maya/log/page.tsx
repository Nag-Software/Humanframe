import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PhoneIcon, PlusIcon, VideoIcon } from "lucide-react";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { getLocale, getTranslations } from "@/lib/i18n";
import { formatClock, formatDayLabel } from "@/lib/i18n/format";
import { decodeCursor } from "@/server/db/cursor";
import { getAssistantBySlug } from "@/server/db/repositories/assistants";
import { listThreads, type Thread } from "@/server/db/repositories/threads";
import { requireRequestScope } from "@/server/db/request-scope";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.maya.log.metaTitle };
}

const CONVERSATION = "/assistants/maya";
const PAGE_SIZE = 40;

/**
 * The log: every conversation with Maya, by day. This is the one place
 * history is listed — the sidebar shows what she is doing now, not what she
 * did. Keyset-paginated, oldest page reachable through "Older".
 */
export default async function MayaLogPage({
  searchParams,
}: PageProps<"/assistants/maya/log">) {
  const scope = await requireRequestScope();
  const params = await searchParams;
  const [t, locale, assistant] = await Promise.all([
    getTranslations(),
    getLocale(),
    getAssistantBySlug(scope.client, scope.workspaceId, "maya"),
  ]);
  if (!assistant) {
    redirect(CONVERSATION);
  }

  const cursor =
    typeof params.cursor === "string" ? decodeCursor(params.cursor) : null;
  const { threads, nextCursor } = await listThreads(scope, {
    limit: PAGE_SIZE,
    assistantId: assistant.id,
    cursor,
  });
  const copy = t.maya.log;
  const groups = groupByDay(threads, (thread) =>
    formatDayLabel(thread.lastMessageAt, locale)
  );

  return (
    <div className="flex h-svh flex-col">
      <div className="flex h-16 shrink-0 items-center gap-1 px-3">
        <SidebarTrigger className="text-muted-foreground" />
        <h1 className="font-display px-1.5 text-base font-semibold tracking-tight">
          {copy.title}
        </h1>
        <Link
          href={`${CONVERSATION}?new=1`}
          className="text-muted-foreground hover:text-foreground ml-auto flex h-8 items-center gap-1.5 rounded-full pr-3 pl-2.5 text-[13px] font-medium transition-colors"
        >
          <PlusIcon className="size-3.5" />
          {t.nav.startFresh}
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-16">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-8">
          <p className="text-muted-foreground text-sm">{copy.description}</p>

          {threads.length === 0 ? (
            <p className="text-muted-foreground border-border/60 border-t py-3 text-sm">
              {copy.empty}
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.label} className="flex flex-col">
                <h2 className="text-muted-foreground pb-2 text-xs font-medium">
                  {group.label}
                </h2>
                <div className="border-border/60 flex flex-col border-b">
                  {group.threads.map((thread) => (
                    <Link
                      key={thread.id}
                      href={`${CONVERSATION}?t=${thread.id}`}
                      className="border-border/60 hover:bg-muted/60 -mx-2 flex items-center gap-3 rounded-lg border-t px-2 py-3 text-sm transition-colors"
                    >
                      <span className="text-muted-foreground w-12 shrink-0 tabular-nums">
                        {formatClock(thread.lastMessageAt, locale)}
                      </span>
                      {thread.channel === "live" ? (
                        <PhoneIcon className="text-call-foreground size-3.5 shrink-0" />
                      ) : null}
                      {thread.channel === "facetime" ? (
                        <VideoIcon className="text-call-foreground size-3.5 shrink-0" />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate">
                        {thread.title ?? t.maya.call.threadTitle}
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            ))
          )}

          {nextCursor ? (
            <Link
              href={`${CONVERSATION}/log?cursor=${encodeURIComponent(nextCursor)}`}
              className="text-muted-foreground hover:text-foreground self-center text-[13px] font-medium transition-colors"
            >
              {copy.older}
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function groupByDay(
  threads: Thread[],
  labelFor: (thread: Thread) => string
): { label: string; threads: Thread[] }[] {
  const groups: { label: string; threads: Thread[] }[] = [];
  for (const thread of threads) {
    const label = labelFor(thread);
    const last = groups.at(-1);
    if (last && last.label === label) {
      last.threads.push(thread);
    } else {
      groups.push({ label, threads: [thread] });
    }
  }
  return groups;
}
