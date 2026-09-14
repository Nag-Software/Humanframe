import { PageShell } from "@/components/page-shell";
import { PageSkeleton } from "@/components/page-skeleton";

export const metadata = { title: "Kalender · Humanframe" };

export default function CalendarPage() {
  return (
    <PageShell title="Kalender" description="Møter og avtaler.">
      <PageSkeleton variant="calendar" />
    </PageShell>
  );
}
