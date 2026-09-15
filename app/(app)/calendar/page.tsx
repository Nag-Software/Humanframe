import type { Metadata } from "next";

import { PageShell } from "@/components/page-shell";
import { PageSkeleton } from "@/components/page-skeleton";
import { getTranslations } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.pages.calendar.metaTitle };
}

export default async function CalendarPage() {
  const t = await getTranslations();

  return (
    <PageShell
      title={t.pages.calendar.title}
      description={t.pages.calendar.description}
    >
      <PageSkeleton variant="calendar" />
    </PageShell>
  );
}
