import { PageSkeleton } from "@/components/page-skeleton";

export const metadata = { title: "Grenser · Innstillinger" };

export default function SettingsLimitsPage() {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Grenser</h2>
        <p className="text-muted-foreground text-sm">Bruk og grenser per assistent.</p>
      </div>
      <PageSkeleton variant="stats" rows={3} />
    </section>
  );
}
