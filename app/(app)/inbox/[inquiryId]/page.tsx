import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon, PhoneIcon } from "lucide-react";
import { z } from "zod";

import { ActionCard } from "@/components/receptionist/action-card";
import { CHANNEL_ICONS } from "@/components/receptionist/channel-icon";
import { formatInZone, formatPhone } from "@/components/receptionist/format";
import { InquiryStatusButtons } from "@/components/receptionist/inquiry-status";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { formatMessage, getLocale, getTranslations } from "@/lib/i18n";
import { requireRequestScope } from "@/server/db/request-scope";
import { UPLOAD_BUCKET } from "@/server/receptionist/uploads";
import { getInquiry, listActions, loadProfile } from "@/server/receptionist/store";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.receptionist.inbox.metaTitle };
}

/** One inquiry: what the caller needed, what is proposed, what was said. */
export default async function InquiryPage({ params }: PageProps<"/inbox/[inquiryId]">) {
  const { inquiryId } = await params;
  if (!z.uuid().safeParse(inquiryId).success) notFound();

  const scope = await requireRequestScope();
  const inquiry = await getInquiry(scope.client, inquiryId, scope.workspaceId);
  if (!inquiry) notFound();

  const [t, locale, profile, actions, files, earlier] = await Promise.all([
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
    inquiry.callerPhone
      ? scope.client
          .from("inquiries")
          .select("id, title, started_at")
          .eq("workspace_id", scope.workspaceId)
          .eq("caller_phone", inquiry.callerPhone)
          .neq("id", inquiry.id)
          .order("started_at", { ascending: false })
          .limit(5)
          .returns<{ id: string; title: string; started_at: string }[]>()
      : Promise.resolve({ data: [] as { id: string; title: string; started_at: string }[] }),
  ]);

  const signed = files.data?.length
    ? await scope.client.storage
        .from(UPLOAD_BUCKET)
        .createSignedUrls(files.data.map((file) => file.storage_path), 3600)
    : { data: [] };

  const copy = t.receptionist.inbox;
  const Icon = CHANNEL_ICONS[inquiry.channel];
  const who = inquiry.callerName ?? (formatPhone(inquiry.callerPhone) || copy.hiddenNumber);
  const pending = inquiry.processing === "pending" || inquiry.processing === "processing";

  return (
    <div className="flex h-svh flex-col">
      <div className="flex h-16 shrink-0 items-center gap-1 px-3">
        <SidebarTrigger className="text-muted-foreground" />
        <Link
          href="/inbox"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 px-1.5 text-sm"
        >
          <ArrowLeftIcon className="size-3.5" />
          {copy.back}
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-16">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8">
          <header className="flex flex-col gap-3">
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <Icon className="size-3.5" />
              <span>{copy.channel[inquiry.channel]}</span>
              <span>·</span>
              <span>{formatInZone(inquiry.startedAt, profile.timezone, locale)}</span>
              {inquiry.durationSeconds ? (
                <>
                  <span>·</span>
                  <span>
                    {formatMessage(copy.duration, { minutes: Math.max(1, Math.round(inquiry.durationSeconds / 60)) })}
                  </span>
                </>
              ) : null}
              {inquiry.urgency === "high" ? <Badge variant="destructive">{copy.urgent}</Badge> : null}
            </div>
            <h1 className="font-display text-xl font-semibold tracking-tight">
              {pending ? copy.processing : inquiry.title || copy.channel[inquiry.channel]}
            </h1>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                <span className="font-medium">{who}</span>
                {inquiry.callerName && inquiry.callerPhone ? (
                  <span className="text-muted-foreground"> · {formatPhone(inquiry.callerPhone)}</span>
                ) : null}
              </p>
              <div className="flex items-center gap-2">
                {inquiry.callerPhone ? (
                  <a
                    href={`tel:${inquiry.callerPhone}`}
                    className="bg-primary text-primary-foreground flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[0.8rem] font-medium"
                  >
                    <PhoneIcon className="size-3.5" />
                    {copy.callBack}
                  </a>
                ) : null}
                <InquiryStatusButtons inquiryId={inquiry.id} status={inquiry.status} />
              </div>
            </div>
            {inquiry.summary ? <p className="text-sm leading-relaxed">{inquiry.summary}</p> : null}
            {inquiry.processing === "failed" ? (
              <p className="text-destructive text-sm">{copy.failed}</p>
            ) : null}
          </header>

          {!pending ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-muted-foreground text-xs font-medium">{copy.proposals}</h2>
              {actions.length === 0 ? (
                <p className="text-muted-foreground text-sm">{copy.noProposals}</p>
              ) : (
                actions.map((action) => (
                  <ActionCard
                    key={action.id}
                    timeZone={profile.timezone}
                    action={{
                      id: action.id,
                      kind: action.kind,
                      status: action.status,
                      payload: action.payload,
                      rationale: action.rationale,
                      error: action.error,
                    }}
                  />
                ))
              )}
            </section>
          ) : null}

          {signed.data && signed.data.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-muted-foreground text-xs font-medium">{copy.files}</h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {signed.data.map((entry, index) => {
                  const file = files.data![index];
                  if (!entry.signedUrl) return null;
                  return file.mime_type.startsWith("image/") ? (
                    <a key={file.id} href={entry.signedUrl} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URLs */}
                      <img
                        src={entry.signedUrl}
                        alt={file.file_name}
                        className="border-border/60 aspect-square w-full rounded-lg border object-cover"
                      />
                    </a>
                  ) : (
                    <a
                      key={file.id}
                      href={entry.signedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="border-border/60 flex aspect-square items-center justify-center rounded-lg border p-2 text-center text-xs break-all"
                    >
                      {file.file_name || file.mime_type}
                    </a>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="flex flex-col gap-3">
            <h2 className="text-muted-foreground text-xs font-medium">{copy.transcript}</h2>
            {inquiry.transcript.trim() ? (
              <div className="flex flex-col gap-2 text-sm">
                {inquiry.transcript.split("\n").map((line, index) => {
                  const [speaker, ...rest] = line.split(": ");
                  const text = rest.join(": ");
                  const fromCaller = speaker.startsWith("Innringer");
                  return (
                    <p key={index} className={fromCaller ? "" : "text-muted-foreground"}>
                      <span className="font-medium">{text ? `${speaker}: ` : ""}</span>
                      {text || line}
                    </p>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">{pending ? copy.processing : copy.noTranscript}</p>
            )}
          </section>

          {earlier.data && earlier.data.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-muted-foreground text-xs font-medium">{copy.previous}</h2>
              <ul className="flex flex-col gap-1 text-sm">
                {earlier.data.map((row) => (
                  <li key={row.id}>
                    <Link href={`/inbox/${row.id}`} className="hover:underline">
                      {formatInZone(row.started_at, profile.timezone, locale, "date")} – {row.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
