import { PageSkeleton } from "@/components/page-skeleton";

export const metadata = { title: "Generelt · Innstillinger" };

export default function SettingsGeneralPage() {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Generelt</h2>
        <p className="text-muted-foreground text-sm">Navn, språk og standardvalg for arbeidsområdet.</p>
      </div>
      <PageSkeleton variant="form" rows={4} />
    </section>
  );
}
