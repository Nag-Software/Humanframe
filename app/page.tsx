import { PageShell } from "@/components/page-shell";
import { PageSkeleton } from "@/components/page-skeleton";

export const metadata = { title: "Oversikt · Humanframe" };

export default function OverviewPage() {
  return (
    <PageShell
      title="Oversikt"
      description="Aktivitet på tvers av assistenter og oppgaver."
    >
      <div className="space-y-8">
        <PageSkeleton variant="stats" />
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Siste aktivitet</h2>
          <PageSkeleton variant="list" rows={4} />
        </div>
      </div>
    </PageShell>
  );
}
