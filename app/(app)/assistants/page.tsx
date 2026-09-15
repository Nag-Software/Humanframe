import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

import { PageShell } from "@/components/page-shell";
import { PageSkeleton } from "@/components/page-skeleton";
import { getTranslations } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.pages.assistants.metaTitle };
}

export default async function AssistantsPage() {
  const t = await getTranslations();

  return (
    <PageShell
      title={t.pages.assistants.title}
      description={t.pages.assistants.description}
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
            <span className="block text-sm font-medium">{t.nav.maya}</span>
            <span className="text-muted-foreground block text-sm">
              {t.pages.assistants.mayaAvailable}
            </span>
          </span>
        </Link>
        <PageSkeleton variant="cards" rows={2} />
      </div>
    </PageShell>
  );
}
