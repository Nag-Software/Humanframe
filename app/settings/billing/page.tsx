import { PageSkeleton } from "@/components/page-skeleton";

export const metadata = { title: "Fakturering · Innstillinger" };

export default function SettingsBillingPage() {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Fakturering</h2>
        <p className="text-muted-foreground text-sm">Abonnement, kvittering og betalingsmåte.</p>
      </div>
      <PageSkeleton variant="list" rows={3} />
    </section>
  );
}
