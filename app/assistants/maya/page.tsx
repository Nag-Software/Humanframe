import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";

import { MayaChat } from "@/components/maya/maya-chat";
import { loadMessages } from "@/lib/maya/store";

export const metadata = {
  title: "Maya · Humanframe",
};

export default async function MayaPage({
  searchParams,
}: PageProps<"/assistants/maya">) {
  const params = await searchParams;
  const conversationId = typeof params.c === "string" ? params.c : undefined;

  // Samtale-id ligger i URL-en, slik at en reload henter riktig tråd.
  if (!conversationId) {
    redirect(`/assistants/maya?c=${randomUUID()}`);
  }

  const initialMessages = await loadMessages(conversationId);

  return (
    <MayaChat
      conversationId={conversationId}
      initialMessages={initialMessages}
    />
  );
}
