import Link from "next/link";
import Image from "next/image";

import { PageShell } from "@/components/page-shell";
import { PageSkeleton } from "@/components/page-skeleton";

export const metadata = { title: "Assistenter · Humanframe" };

export default function AssistantsPage() {
  return (
    <PageShell
      title="Assistenter"
      description="Assistentene som er satt opp for arbeidsområdet ditt."
    >
      <div className="space-y-4">
        <Link
          href="/assistants/maya"
          className="border-border/60 hover:bg-muted/50 flex items-center gap-3 rounded-xl border p-4 transition-colors"
        >
          <Image
            src="/assistants/maya-avatar.png"
            alt=""
            width={40}
            height={40}
            className="size-10 rounded-full object-cover"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Maya</span>
            <span className="text-muted-foreground block text-sm">
              AI-assistent · tilgjengelig
            </span>
          </span>
        </Link>
        <PageSkeleton variant="cards" rows={2} />
      </div>
    </PageShell>
  );
}
