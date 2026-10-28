import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRightIcon, MailIcon, MapPinIcon, PhoneIcon } from "lucide-react";
import { z } from "zod";

import { CopyButton } from "@/components/hf/copy-button";
import { formatNok } from "@/components/hf/money";
import { Page, PageHeader, Section } from "@/components/hf/page";
import { Initials, Pill, Surface } from "@/components/hf/surface";
import { ActionCard } from "@/components/receptionist/action-card";
import { CHANNEL_ICONS } from "@/components/receptionist/channel-icon";
import { formatInZone, formatPhone } from "@/components/receptionist/format";
import { InquiryStatusButtons } from "@/components/receptionist/inquiry-status";
import { formatMessage, getLocale, getTranslations } from "@/lib/i18n";
import { requireRequestScope } from "@/server/db/request-scope";
import { portalUrl } from "@/server/receptionist/portal";
import { listQuotes } from "@/server/receptionist/quotes";
import { getInquiry, listActions, loadProfile } from "@/server/receptionist/store";
import { UPLOAD_BUCKET } from "@/server/receptionist/uploads";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.receptionist.inbox.metaTitle };
}

/** One request: what the customer needs, what is proposed, what was said. */
export default async function InquiryPage({ params }: PageProps<"/inbox/[inquiryId]">) {
  const { inquiryId } = await params;
  if (!z.uuid().safeParse(inquiryId).success) notFound();

  const scope = await requireRequestScope();
  const inquiry = await getInquiry(scope.client, inquiryId, scope.workspaceId);
  if (!inquiry || inquiry.status === "draft") notFound();

  const [t, locale, profile, actions, files, earlier, quotes, portal] = await Promise.all([
    getTranslations(),
    getLocale(),
    loadProfile(scope.client, scope.workspaceId),
    listActions(scope.client, scope.workspaceId, [inquiry.id]),
    scope.client
      .from("inquiry_files")
      .select("id, storage_path, file_name, mime_type")
      .eq("inquiry_id", inquiry.id)
      .order("created_at", { ascending: true })
      .returns<{ id: string; storage_path: string; file_name: string; mime_type: string }[]>(),
    inquiry.callerPhone || inquiry.callerEmail
      ? scope.client
          .from("inquiries")
          .select("id, title, started_at")
          .eq("workspace_id", scope.workspaceId)
          .eq(inquiry.callerPhone ? "caller_phone" : "caller_email", inquiry.callerPhone ?? inquiry.callerEmail)
          .neq("id", inquiry.id)
          .neq("status", "draft")
          .order("started_at", { ascending: false })
          .limit(5)
          .returns<{ id: string; title: string; started_at: string }[]>()
      : Promise.resolve({ data: [] as { id: string; title: string; started_at: string }[] }),
    listQuotes(scope.client, scope.workspaceId, { inquiryId: inquiry.id }),
    scope.client.from("inquiry_portals").select("token").eq("inquiry_id", inquiry.id).maybeSingle<{ token: string }>(),
  ]);

  const signed = files.data?.length
    ? await scope.client.storage.from(UPLOAD_BUCKET).createSignedUrls(files.data.map((file) => file.storage_path), 3600)
    : { data: [] };

  const copy = t.receptionist.inbox;
  const quoteCopy = t.receptionist.quotes;
  const Icon = CHANNEL_ICONS[inquiry.channel];
  const who = inquiry.callerName ?? (formatPhone(inquiry.callerPhone) || inquiry.callerEmail || copy.hiddenNumber);
  const pending = inquiry.processing === "pending" || inquiry.processing === "processing";
  const address = typeof inquiry.intake.address === "string" ? inquiry.intake.address : null;
  const customerLink = portal.data ? portalUrl(portal.data.token) : null;

  return (
    <Page width="wide">
      <PageHeader
        back={{ href: "/inbox", label: copy.back }}
        eyebrow={
          <>
            <Icon className="size-3.5" />
            {copy.channel[inquiry.channel]} · {formatInZone(inquiry.startedAt, profile.timezone, locale)}
            {inquiry.durationSeconds
              ? ` · ${formatMessage(copy.duration, { minutes: Math.max(1, Math.round(inquiry.durationSeconds / 60)) })}`
              : ""}
          </>
        }
        title={pending ? copy.processing : inquiry.title || copy.channel[inquiry.channel]}
        description={inquiry.summary || undefined}
        actions={<InquiryStatusButtons inquiryId={inquiry.id} status={inquiry.status} />}
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-10">
          {inquiry.processing === "failed" ? (
            <p className="bg-ember-soft text-ember rounded-xl px-4 py-3 text-sm">{copy.failed}</p>
          ) : null}

          {!pending ? (
            <Section title={copy.proposals}>
              {actions.length === 0 ? (
                <p className="text-muted-foreground text-sm">{copy.noProposals}</p>
              ) : (
                <div className="flex flex-col gap-4">
                  {actions.map((action) => (
                    <ActionCard
                      key={action.id}
                      timeZone={profile.timezone}
                      pricesIncludeVat={profile.pricesIncludeVat}
                      action={{
                        id: action.id,
                        kind: action.kind,
                        status: action.status,
                        payload: action.payload,
                        rationale: action.rationale,
                        error: action.error,
                      }}
                    />
                  ))}
                </div>
              )}
            </Section>
          ) : null}

          {signed.data && signed.data.length > 0 ? (
            <Section title={copy.files}>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {signed.data.map((entry, index) => {
                  const file = files.data![index];
                  if (!entry.signedUrl) return null;
                  return file.mime_type.startsWith("image/") ? (
                    <a key={file.id} href={entry.signedUrl} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-xl">
                      {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URLs */}
                      <img
                        src={entry.signedUrl}
                        alt={file.file_name}
                        className="shadow-hairline aspect-square w-full rounded-xl object-cover transition-transform group-hover:scale-[1.02]"
                      />
                    </a>
                  ) : (
                    <a
                      key={file.id}
                      href={entry.signedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="bg-card shadow-hairline flex aspect-square items-center justify-center rounded-xl p-3 text-center text-xs break-all"
                    >
                      {file.file_name || file.mime_type}
                    </a>
                  );
                })}
              </div>
            </Section>
          ) : null}

          <Section title={copy.conversation}>
            <Surface className="p-5">
              {inquiry.transcript.trim() ? (
                <div className="flex flex-col gap-3 text-[14px] leading-relaxed">
                  {inquiry.transcript.split("\n").map((line, index) => {
                    const [speaker, ...rest] = line.split(": ");
                    const said = rest.join(": ");
                    const fromCustomer = /^(Innringer|Kunde)/.test(speaker);
                    if (!said) {
                      return (
                        <p key={index} className="text-muted-foreground text-center text-xs">
                          {line}
                        </p>
                      );
                    }
                    return (
                      <div key={index} className={fromCustomer ? "flex justify-start" : "flex justify-end"}>
                        <div
                          className={
                            fromCustomer
                              ? "bg-muted/70 max-w-[85%] rounded-2xl rounded-bl-md px-4 py-2.5"
                              : "bg-fjord-soft text-foreground max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5"
                          }
                        >
                          <span className="text-muted-foreground mb-0.5 block text-[11px] font-medium">{speaker}</span>
                          {said}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">{pending ? copy.processing : copy.noTranscript}</p>
              )}
            </Surface>
          </Section>
        </div>

        <aside className="flex flex-col gap-5">
          <Surface className="flex flex-col gap-4 p-5">
            <div className="flex items-center gap-3">
              <Initials name={who} className="size-11 text-sm" />
              <div className="min-w-0">
                <p className="truncate font-medium">{who}</p>
                {inquiry.urgency === "high" ? <Pill tone="ember">{copy.urgent}</Pill> : null}
              </div>
            </div>
            <div className="flex flex-col gap-2 text-sm">
              {inquiry.callerPhone ? (
                <a href={`tel:${inquiry.callerPhone}`} className="hover:text-fjord flex items-center gap-2">
                  <PhoneIcon className="text-muted-foreground size-4" />
                  {formatPhone(inquiry.callerPhone)}
                </a>
              ) : null}
              {inquiry.callerEmail ? (
                <a href={`mailto:${inquiry.callerEmail}`} className="hover:text-fjord flex items-center gap-2 break-all">
                  <MailIcon className="text-muted-foreground size-4 shrink-0" />
                  {inquiry.callerEmail}
                </a>
              ) : null}
              {address ? (
                <span className="flex items-center gap-2">
                  <MapPinIcon className="text-muted-foreground size-4 shrink-0" />
                  {address}
                </span>
              ) : null}
            </div>
            {inquiry.callerPhone ? (
              <a
                href={`tel:${inquiry.callerPhone}`}
                className="bg-primary text-primary-foreground flex h-10 items-center justify-center gap-2 rounded-xl text-sm font-semibold"
              >
                <PhoneIcon className="size-4" />
                {copy.callBack}
              </a>
            ) : null}
          </Surface>

          {customerLink ? (
            <Surface className="flex flex-col gap-3 p-5">
              <p className="text-sm font-semibold">{copy.customerPage}</p>
              <p className="text-muted-foreground truncate font-mono text-xs">{customerLink.replace(/^https?:\/\//, "")}</p>
              <div className="flex gap-2">
                <CopyButton value={customerLink} label={copy.copyLink} copiedLabel={copy.copied} />
                <a
                  href={customerLink}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:bg-accent flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[0.8rem] font-medium"
                >
                  <ArrowUpRightIcon className="size-3.5" />
                </a>
              </div>
            </Surface>
          ) : null}

          {quotes.length > 0 ? (
            <Surface className="flex flex-col gap-3 p-5">
              <p className="text-sm font-semibold">{copy.quotesOnThis}</p>
              {quotes.map((quote) => (
                <div key={quote.id} className="flex items-center justify-between gap-2">
                  <span className="text-sm">{formatMessage(quoteCopy.number, { number: quote.number })}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-serif tabular text-lg">{formatNok(quote.total)}</span>
                    <Pill tone={quote.status === "accepted" ? "fjord" : quote.status === "sent" ? "brass" : "quiet"}>
                      {quoteCopy.status[quote.status]}
                    </Pill>
                  </span>
                </div>
              ))}
            </Surface>
          ) : null}

          {earlier.data && earlier.data.length > 0 ? (
            <Surface tone="muted" className="flex flex-col gap-2 p-5">
              <p className="text-sm font-semibold">{copy.previous}</p>
              {earlier.data.map((row) => (
                <Link key={row.id} href={`/inbox/${row.id}`} className="text-muted-foreground hover:text-foreground text-sm">
                  {formatInZone(row.started_at, profile.timezone, locale, "date")} – {row.title}
                </Link>
              ))}
            </Surface>
          ) : null}
        </aside>
      </div>
    </Page>
  );
}
