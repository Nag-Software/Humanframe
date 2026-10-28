import { notFound } from "next/navigation";

import { Page, PageHeader, Section } from "@/components/hf/page";
import { formatNok } from "@/components/hf/money";
import { Initials, Pill, Stat, Surface } from "@/components/hf/surface";
import { PortalView } from "@/components/portal/portal-view";
import { ActionCard } from "@/components/receptionist/action-card";
import { SidebarProvider } from "@/components/ui/sidebar";
import { WidgetChat } from "@/components/widget/widget-chat";

/**
 * Design previews with sample data, for screenshots and review without a
 * database. Never served in production.
 */
export default async function PreviewPage({ params }: PageProps<"/preview/[screen]">) {
  if (process.env.NODE_ENV === "production" && process.env.HUMANFRAME_PREVIEW !== "true") notFound();
  const { screen } = await params;
  const slots = [1, 2, 3, 4].map((day) => new Date(Date.UTC(2026, 10, day + 2, 7)).toISOString());

  if (screen === "portal") {
    return (
      <PortalView
        token="preview"
        business={{ name: "Hansen Rør", phone: "55 12 34 56", email: "post@hansenror.no", color: null, timeZone: "Europe/Oslo" }}
        inquiry={{
          title: "Lekkasje under kjøkkenvask",
          summary: "Drypper fra koblingen under vasken, verst når oppvaskmaskinen går. Kjøkkenet er fra 2012.",
          customerName: "Kari Nordmann",
          startedAt: new Date().toISOString(),
          status: "open",
          photos: 3,
        }}
        quotes={[
          {
            id: "00000000-0000-0000-0000-000000000001",
            number: 14,
            status: "sent",
            title: "Utbedring av lekkasje",
            lines: [
              { description: "Feilsøking og utbedring", quantity: 2, unit: "time", unitPrice: 950 },
              { description: "Nytt blandebatteri", quantity: 1, unit: "stk", unitPrice: 2260 },
              { description: "Oppmøte", quantity: 1, unit: "fast", unitPrice: 690 },
            ],
            notes: "Forutsetter at stoppekranen virker.",
            terms: "Betaling 14 dager. Materialer etter medgått.",
            pricesIncludeVat: true,
            subtotal: 3880,
            vat: 970,
            total: 4850,
            validUntil: "2026-11-28",
          },
        ]}
        booked={null}
        requested={null}
        slots={slots}
      />
    );
  }

  if (screen === "widget") {
    return (
      <WidgetChat
        widgetKey="preview"
        embedded
        origin={null}
        business={{ name: "Hansen Rør", greeting: "", color: null, area: "Bergen" }}
        demo={{
          messages: [
            { role: "assistant", content: "Hei! Jeg hjelper deg å sende en forespørsel til Hansen Rør. Hva kan vi hjelpe deg med?" },
            { role: "user", content: "Det lekker under kjøkkenvasken, mest når oppvaskmaskinen går." },
            { role: "assistant", content: "Det høres ut som koblingen. Ta gjerne et bilde under vasken med binders-knappen, så ser rørleggeren det med en gang." },
            { role: "user", content: "Jeg har lagt ved 3 bilder." },
            { role: "assistant", content: "Takk, det hjelper! Hvor er det, og hva er navnet og nummeret ditt?" },
            { role: "user", content: "Storgata 12 i Bergen. Kari Nordmann, 912 34 567." },
            { role: "assistant", content: "Supert, Kari. Jeg har alt eieren trenger. Trykk «Send forespørsel», så får du tilbud eller forslag til tid." },
          ],
          photos: 3,
          collected: { name: "Kari Nordmann", phone: "91234567", email: null, address: "Storgata 12, Bergen", job: "Lekkasje under kjøkkenvask", when: "Neste uke" },
          canSubmit: true,
        }}
      />
    );
  }

  if (screen === "actions") {
    return (
      <SidebarProvider>
        <main className="w-full">
          <Page width="wide">
            <PageHeader
              back={{ href: "#", label: "Forespørsler" }}
              eyebrow="Nettside · tor. 29. okt. 10:14"
              title="Lekkasje under kjøkkenvask"
              description="Kari Nordmann melder om drypp fra koblingen under kjøkkenvasken, verst når oppvaskmaskinen går. Hun har lagt ved tre bilder og ønsker besøk i neste uke."
            />
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
              <Section title="Forslag til neste steg">
                <div className="flex flex-col gap-4">
                  <ActionCard
                    timeZone="Europe/Oslo"
                    pricesIncludeVat
                    action={{
                      id: "a1",
                      kind: "quote",
                      status: "proposed",
                      rationale: "Beregnet fra prislisten din: 4 850 kr inkl. mva. Juster før du sender.",
                      error: null,
                      payload: {
                        title: "Utbedring av lekkasje",
                        lines: [
                          { description: "Feilsøking og utbedring", quantity: 2, unit: "time", unitPrice: 950 },
                          { description: "Nytt blandebatteri", quantity: 1, unit: "stk", unitPrice: 2260 },
                          { description: "Oppmøte", quantity: 1, unit: "fast", unitPrice: 690 },
                        ],
                        notes: "Forutsetninger: stoppekranen virker",
                        customerName: "Kari Nordmann",
                        customerEmail: "kari@example.no",
                        customerPhone: "+4791234567",
                      },
                    }}
                  />
                  <ActionCard
                    timeZone="Europe/Oslo"
                    pricesIncludeVat
                    action={{
                      id: "a2",
                      kind: "booking",
                      status: "proposed",
                      rationale: "Kunden valgte tirsdag 3. november kl. 08:00 på kundesiden.",
                      error: null,
                      payload: {
                        startsAt: slots[0],
                        endsAt: new Date(Date.parse(slots[0]) + 3_600_000).toISOString(),
                        title: "Lekkasje – Kari Nordmann",
                        address: "Storgata 12, Bergen",
                        customerPhone: "+4791234567",
                        confirmationSms: "Hei Kari! Vi bekrefter tirsdag 3. november kl. 08:00. Passer det ikke, svar på denne meldingen.\nHilsen Hansen Rør",
                      },
                    }}
                  />
                  <ActionCard
                    timeZone="Europe/Oslo"
                    pricesIncludeVat
                    action={{
                      id: "a3",
                      kind: "reply",
                      status: "done",
                      rationale: "Utkast til svar til kunden.",
                      error: null,
                      payload: { to: null, email: "kari@example.no", body: "Hei Kari! Takk for bildene – vi ser på det i dag.\nHilsen Hansen Rør" },
                    }}
                  />
                </div>
              </Section>
              <aside className="flex flex-col gap-5">
                <Surface className="flex flex-col gap-4 p-5">
                  <div className="flex items-center gap-3">
                    <Initials name="Kari Nordmann" className="size-11 text-sm" />
                    <p className="font-medium">Kari Nordmann</p>
                  </div>
                  <p className="text-muted-foreground text-sm">912 34 567 · kari@example.no</p>
                </Surface>
                <Surface className="grid grid-cols-2 gap-5 p-5">
                  <Stat label="Tilbudt" value={formatNok(4850)} tone="brass" />
                  <Stat label="Bilder" value={3} />
                </Surface>
                <Surface className="flex items-center justify-between p-5">
                  <span className="text-sm">Tilbud 14</span>
                  <Pill tone="brass">Sendt</Pill>
                </Surface>
              </aside>
            </div>
          </Page>
        </main>
      </SidebarProvider>
    );
  }

  notFound();
}
