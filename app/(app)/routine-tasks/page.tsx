import { PageShell } from "@/components/page-shell";
import { PageSkeleton } from "@/components/page-skeleton";

export const metadata = { title: "Rutineoppgaver · Humanframe" };

export default function RoutineTasksPage() {
  return (
    <PageShell
      title="Rutineoppgaver"
      description="Oppgaver som kjører etter en fast plan."
    >
      <PageSkeleton variant="list" rows={6} />
    </PageShell>
  );
}
