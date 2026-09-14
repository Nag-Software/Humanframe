import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";

import { MayaChat } from "@/components/maya/maya-chat";
import {
  listMessages,
  toUiMessages,
} from "@/server/db/repositories/messages";
import { getThread } from "@/server/db/repositories/threads";
import { requireRequestScope } from "@/server/db/request-scope";

export const metadata = {
  title: "Maya · Humanframe",
};

const threadIdSchema = z.uuid();
const INITIAL_PAGE_SIZE = 50;

export default async function MayaPage({
  searchParams,
}: PageProps<"/assistants/maya">) {
  const scope = await requireRequestScope();
  const params = await searchParams;
  const threadId = threadIdSchema.safeParse(params.t ?? params.c);

  // The thread id lives in the URL so a reload reopens the same conversation.
  if (!threadId.success) {
    redirect(`/assistants/maya?t=${randomUUID()}`);
  }

  // Newest page first via keyset pagination; row level security scopes this to
  // the caller's workspace, so a thread owned by someone else comes back empty.
  const [{ messages, nextCursor }, thread] = await Promise.all([
    listMessages(scope, { threadId: threadId.data, limit: INITIAL_PAGE_SIZE }),
    getThread(scope, threadId.data),
  ]);

  return (
    <MayaChat
      threadId={threadId.data}
      initialMessages={toUiMessages(messages)}
      olderMessagesCursor={nextCursor}
      eveSessionId={thread?.eveSessionId ?? null}
    />
  );
}
