import type { Metadata } from "next";

import { PageShell } from "@/components/page-shell";
import { PageSkeleton } from "@/components/page-skeleton";
import { getTranslations } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.pages.overview.metaTitle };
}

export default async function OverviewPage() {
  const t = await getTranslations();

  return (
    <PageShell
      title={t.pages.overview.title}
      description={t.pages.overview.description}
    >
      <div className="space-y-8">
        <PageSkeleton variant="stats" />
        <div className="space-y-3">
          <h2 className="text-sm font-medium">
            {t.pages.overview.recentActivity}
          </h2>
          <PageSkeleton variant="list" rows={4} />
        </div>
      </div>
    </PageShell>
  );
}
