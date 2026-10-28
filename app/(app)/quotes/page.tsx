import type { Metadata } from "next";
import Link from "next/link";
import { FileTextIcon } from "lucide-react";

import { formatNok } from "@/components/hf/money";
import { Page, PageHeader } from "@/components/hf/page";
import { EmptyState, Pill, Stat, Surface } from "@/components/hf/surface";
import { formatInZone } from "@/components/receptionist/format";
import { formatMessage, getLocale, getTranslations } from "@/lib/i18n";
import { requireRequestScope } from "@/server/db/request-scope";
import { listQuotes } from "@/server/receptionist/quotes";
import { loadProfile } from "@/server/receptionist/store";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.receptionist.quotes.metaTitle };
}

/** Every quote sent, and what came of it — the money view of the product. */
export default async function QuotesPage() {
  const scope = await requireRequestScope();
  const [t, locale, profile, quotes] = await Promise.all([
    getTranslations(),
    getLocale(),
    loadProfile(scope.client, scope.workspaceId),
    listQuotes(scope.client, scope.workspaceId, { limit: 200 }),
  ]);
  const copy = t.receptionist.quotes;
  const accepted = quotes.filter((quote) => quote.status === "accepted");
  const decided = quotes.filter((quote) => quote.status === "accepted" || quote.status === "declined");
  const acceptedValue = accepted.reduce((sum, quote) => sum + quote.total, 0);
  const rate = decided.length ? Math.round((accepted.length / decided.length) * 100) : null;

  return (
    <Page>
      <PageHeader eyebrow={profile.name || scope.workspace.name} title={copy.title} description={copy.description} />

      {quotes.length === 0 ? (
        <EmptyState icon={<FileTextIcon className="size-5" />} title={copy.title} body={copy.empty} />
      ) : (
        <>
          <Surface className="grid grid-cols-2 gap-6 p-6 sm:grid-cols-4">
            <Stat label={copy.sent} value={quotes.length} />
            <Stat label={copy.accepted} value={accepted.length} tone="fjord" />
            <Stat label={copy.value} value={formatNok(acceptedValue)} tone="brass" />
            <Stat label={copy.rate} value={rate === null ? "–" : `${rate} %`} />
          </Surface>

          <Surface as="section" className="overflow-hidden">
            <ul className="divide-border divide-y">
              {quotes.map((quote) => (
                <li key={quote.id}>
                  <Link
                    href={`/inbox/${quote.inquiryId}`}
                    className="hover:bg-accent/50 flex items-center gap-4 px-5 py-4 transition-colors"
                  >
                    <span className="bg-brass-soft text-[color:oklch(0.48_0.09_72)] dark:text-brass font-serif tabular flex size-10 shrink-0 items-center justify-center rounded-xl text-lg">
                      {quote.number}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium">{quote.title}</p>
                      <p className="text-muted-foreground truncate text-sm">
                        {[quote.customerName, formatInZone(quote.sentAt, profile.timezone, locale, "date")]
                          .filter(Boolean)
                          .join(" · ")}
                        {quote.status === "sent"
                          ? ` · ${formatMessage(copy.validUntil, { date: quote.validUntil.split("-").reverse().join(".") })}`
                          : ""}
                      </p>
                    </div>
                    <span className="font-serif tabular shrink-0 text-xl">{formatNok(quote.total)}</span>
                    <Pill
                      tone={
                        quote.status === "accepted"
                          ? "fjord"
                          : quote.status === "sent"
                            ? "brass"
                            : quote.status === "declined"
                              ? "ember"
                              : "quiet"
                      }
                    >
                      {copy.status[quote.status]}
                    </Pill>
                  </Link>
                </li>
              ))}
            </ul>
          </Surface>
        </>
      )}
    </Page>
  );
}
