import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";

import { hasSomethingToOpen } from "@/agent/lib/opening";
import { MayaChat } from "@/components/maya/maya-chat";
import { publicEnv } from "@/lib/env";
import { getTranslations } from "@/lib/i18n";
import { getAssistantBySlug } from "@/server/db/repositories/assistants";
import { nextCommitment } from "@/server/db/repositories/commitments";
import { loadOpeningBrief } from "@/server/db/repositories/opening";
import { listMessages, toUiMessages } from "@/server/db/repositories/messages";
import { getThread, listThreads } from "@/server/db/repositories/threads";
import { requireRequestScope } from "@/server/db/request-scope";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.nav.maya };
}

const threadIdSchema = z.uuid();
const INITIAL_PAGE_SIZE = 50;

/**
 * How long a conversation stays "where you left off". A thread touched inside
 * this window is reopened as if you never left; an older one is left in the
 * history and a new day starts. To the user both look like one stream.
 */
const CONTINUE_WITHIN_MS = 24 * 60 * 60_000;

function touchedWithin(iso: string, windowMs: number): boolean {
  return Date.now() - new Date(iso).getTime() < windowMs;
}

function passthroughQuery(
  params: Record<string, string | string[] | undefined>,
  keys: readonly string[]
): string {
  const query = new URLSearchParams();
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string") {
      query.set(key, value);
    }
  }
  return query.toString();
}

export default async function MayaPage({
  searchParams,
}: PageProps<"/assistants/maya">) {
  const scope = await requireRequestScope();
  const params = await searchParams;
  const threadId = threadIdSchema.safeParse(params.t ?? params.c);
  const runsOnEve = publicEnv.NEXT_PUBLIC_MAYA_RUNTIME === "eve";
  const startFresh = params.new === "1";

  const assistant = await getAssistantBySlug(
    scope.client,
    scope.workspaceId,
    "maya"
  );
  const holding = assistant
    ? await nextCommitment(scope.client, scope.workspaceId, assistant.id)
    : null;

  if (!threadId.success) {
    if (!runsOnEve) {
      redirect(`/assistants/maya?t=${randomUUID()}`);
    }

    // A returning user lands where they left off, not on an introduction.
    if (!startFresh && assistant) {
      const { threads } = await listThreads(scope, {
        limit: 1,
        assistantId: assistant.id,
      });
      const latest = threads[0];
      if (latest && touchedWithin(latest.lastMessageAt, CONTINUE_WITHIN_MS)) {
        const rest = passthroughQuery(params, ["settings", "call"]);
        redirect(`/assistants/maya?t=${latest.id}${rest ? `&${rest}` : ""}`);
      }
    }

    // She opens the day only when there is something to open it with, and
    // never when the user asked for a clean slate.
    const openable =
      !startFresh &&
      assistant !== null &&
      hasSomethingToOpen(
        await loadOpeningBrief(scope.client, {
          workspaceId: scope.workspaceId,
          assistantId: assistant.id,
          userId: scope.userId,
        })
      );

    return (
      <MayaChat
        threadId={null}
        initialMessages={[]}
        holding={holding}
        openable={openable}
      />
    );
  }

  // Row level security scopes both reads to the caller's workspace, so a
  // thread owned by someone else comes back empty.
  const [{ messages, nextCursor }, thread] = await Promise.all([
    listMessages(scope, { threadId: threadId.data, limit: INITIAL_PAGE_SIZE }),
    getThread(scope, threadId.data),
  ]);

  if (runsOnEve && !thread) {
    // An unknown or foreign thread id: start a fresh conversation instead of
    // rendering an empty shell bound to nothing.
    redirect("/assistants/maya?new=1");
  }

  return (
    <MayaChat
      threadId={threadId.data}
      initialMessages={toUiMessages(messages)}
      olderMessagesCursor={nextCursor}
      eveSessionId={thread?.eveSessionId ?? null}
      holding={holding}
    />
  );
}
