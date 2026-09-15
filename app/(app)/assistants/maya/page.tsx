import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";

import { MayaChat } from "@/components/maya/maya-chat";
import { publicEnv } from "@/lib/env";
import { getTranslations } from "@/lib/i18n";
import { listMessages, toUiMessages } from "@/server/db/repositories/messages";
import { getThread } from "@/server/db/repositories/threads";
import { requireRequestScope } from "@/server/db/request-scope";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.nav.maya };
}

const threadIdSchema = z.uuid();
const INITIAL_PAGE_SIZE = 50;

export default async function MayaPage({
  searchParams,
}: PageProps<"/assistants/maya">) {
  const scope = await requireRequestScope();
  const params = await searchParams;
  const threadId = threadIdSchema.safeParse(params.t ?? params.c);
  const runsOnEve = publicEnv.NEXT_PUBLIC_MAYA_RUNTIME === "eve";

  if (!threadId.success) {
    // On eve the thread is created server-side with the first message, and the
    // client then adopts the id the database minted. The AI SDK path still
    // mints its own id up front.
    if (!runsOnEve) {
      redirect(`/assistants/maya?t=${randomUUID()}`);
    }

    return <MayaChat threadId={null} initialMessages={[]} />;
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
    redirect("/assistants/maya");
  }

  return (
    <MayaChat
      threadId={threadId.data}
      initialMessages={toUiMessages(messages)}
      olderMessagesCursor={nextCursor}
      eveSessionId={thread?.eveSessionId ?? null}
    />
  );
}
