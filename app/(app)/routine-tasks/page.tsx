import type { Metadata } from "next";

import { PageShell } from "@/components/page-shell";
import { PageSkeleton } from "@/components/page-skeleton";
import { getTranslations } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.pages.routineTasks.metaTitle };
}

export default async function RoutineTasksPage() {
  const t = await getTranslations();

  return (
    <PageShell
      title={t.pages.routineTasks.title}
      description={t.pages.routineTasks.description}
    >
      <PageSkeleton variant="list" rows={6} />
    </PageShell>
  );
}
