import { PageSkeleton } from "@/components/page-skeleton";

export const metadata = { title: "Team · Innstillinger" };

export default function SettingsTeamPage() {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Team</h2>
        <p className="text-muted-foreground text-sm">Medlemmer og tilganger.</p>
      </div>
      <PageSkeleton variant="cards" rows={4} />
    </section>
  );
}
