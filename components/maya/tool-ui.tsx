"use client";

import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  CalendarIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MailIcon,
} from "lucide-react";

import { ApprovalCard } from "@/components/assistant-ui/elements/approval-card";
import { WebSearch } from "@/components/assistant-ui/elements/web-search";
import {
  Source,
  SourceIcon,
  SourceTitle,
} from "@/components/assistant-ui/elements/sources.aui";
import { cn } from "@/lib/utils";

const card =
  "border-border/60 bg-card/60 flex w-full max-w-md flex-col gap-2 rounded-2xl border p-4";

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const faviconOf = (url: string) =>
  `https://www.google.com/s2/favicons?sz=64&domain=${domainOf(url)}`;

/** Websøk: "Søker på nettet" mens det pågår, kildeliste når det er ferdig. */
export const WebSearchToolUI = makeAssistantToolUI<
  { query?: string },
  unknown
>({
  toolName: "webSearch",
  render: ({ args, result, status }) => {
    const running = status.type === "running";
    // Anthropic returnerer treffene i result; OpenAI sender dem som
    // source-parts i stedet, og da rendres de av tråden.
    const results = (
      Array.isArray(result) ? result : []
    ) as { url: string; title: string | null }[];

    if (results.length === 0) {
      if (!running) {
        return null;
      }
      return (
        <WebSearch
          className="my-2"
          query={args?.query ?? ""}
          results={[]}
          visibleResults={0}
          searching={running}
          cycle={0}
        />
      );
    }

    return (
      <div className="my-2 flex flex-wrap gap-1.5">
        {results.slice(0, 6).map((item) => (
          <Source key={item.url} href={item.url} variant="muted" size="sm">
            <SourceIcon url={item.url} />
            <SourceTitle>{item.title ?? domainOf(item.url)}</SourceTitle>
          </Source>
        ))}
      </div>
    );
  },
});

/** Lenkekort med favicon, tittel, domene og beskrivelse. */
export const ShowWebsiteToolUI = makeAssistantToolUI<
  { url: string; title: string; description: string; preview?: boolean },
  { url: string; title: string; description: string; preview?: boolean }
>({
  toolName: "showWebsite",
  render: ({ args, status }) => {
    if (status.type === "running" || !args?.url) {
      return (
        <p className="text-muted-foreground my-2 text-sm">Henter lenke …</p>
      );
    }

    return (
      <a
        href={args.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(card, "my-2 transition-colors hover:bg-muted/50")}
      >
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={faviconOf(args.url)}
            alt=""
            className="size-4 rounded-sm"
            loading="lazy"
          />
          <span className="text-muted-foreground text-xs">
            {domainOf(args.url)}
          </span>
          <ExternalLinkIcon className="text-muted-foreground ms-auto size-3.5" />
        </div>
        <p className="text-sm font-medium">{args.title}</p>
        <p className="text-muted-foreground text-sm">{args.description}</p>
      </a>
    );
  },
});

/** Nedlastbar fil som et kompakt filkort. */
export const CreateFileToolUI = makeAssistantToolUI<
  { filename: string },
  { filename: string; mediaType: string; size: number; url: string }
>({
  toolName: "createFile",
  render: ({ args, result, status }) => {
    if (status.type === "running" || !result) {
      return (
        <p className="text-muted-foreground my-2 text-sm">
          Lager {args?.filename ?? "fil"} …
        </p>
      );
    }

    return (
      <a
        href={result.url}
        download={result.filename}
        className={cn(
          card,
          "my-2 max-w-sm flex-row items-center gap-3 transition-colors hover:bg-muted/50"
        )}
      >
        <span className="bg-muted flex size-9 items-center justify-center rounded-xl">
          <DownloadIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {result.filename}
          </span>
          <span className="text-muted-foreground block text-xs">
            {Math.max(1, Math.round(result.size / 1024))} kB
          </span>
        </span>
      </a>
    );
  },
});

/** E-postutkast. */
export const DraftEmailToolUI = makeAssistantToolUI<
  { to: string[]; subject: string; body: string },
  { to: string[]; subject: string; body: string }
>({
  toolName: "draftEmail",
  render: ({ args, status }) => {
    if (status.type === "running" || !args?.subject) {
      return (
        <p className="text-muted-foreground my-2 text-sm">
          Skriver e-postutkast …
        </p>
      );
    }
    return (
      <div className={cn(card, "my-2")}>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <MailIcon className="size-3.5" />
          Utkast
        </div>
        <p className="text-muted-foreground text-xs">
          Til: {args.to?.join(", ")}
        </p>
        <p className="text-sm font-medium">{args.subject}</p>
        <p className="text-sm whitespace-pre-wrap">{args.body}</p>
      </div>
    );
  },
});

/** Forslag til kalenderhendelse. */
export const CalendarEventToolUI = makeAssistantToolUI<
  {
    title: string;
    start: string;
    end: string;
    location?: string;
    attendees?: string[];
  },
  unknown
>({
  toolName: "previewCalendarEvent",
  render: ({ args, status }) => {
    if (status.type === "running" || !args?.title) {
      return (
        <p className="text-muted-foreground my-2 text-sm">
          Sjekker kalenderen …
        </p>
      );
    }

    const format = (value: string) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime())
        ? value
        : new Intl.DateTimeFormat("nb-NO", {
            dateStyle: "full",
            timeStyle: "short",
          }).format(date);
    };

    return (
      <div className={cn(card, "my-2")}>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <CalendarIcon className="size-3.5" />
          Forslag til møte
        </div>
        <p className="text-sm font-medium">{args.title}</p>
        <p className="text-muted-foreground text-sm">{format(args.start)}</p>
        {args.location ? (
          <p className="text-muted-foreground text-sm">{args.location}</p>
        ) : null}
        {args.attendees?.length ? (
          <p className="text-muted-foreground text-xs">
            {args.attendees.join(", ")}
          </p>
        ) : null}
      </div>
    );
  },
});

/** Godkjenningskort for verktøy som må spørre først. */
export const FetchUrlToolUI = makeAssistantToolUI<
  { url: string; reason: string },
  { url: string; excerpt: string }
>({
  toolName: "fetchUrl",
  render: ({ args, approval, status, respondToApproval }) => {
    const pending = approval && approval.approved === undefined;

    if (pending) {
      return (
        <ApprovalCard
          className="my-2"
          state="request"
          title="Åpne nettside"
          subtitle={args?.reason ?? "Maya vil lese innholdet på siden"}
          command={args?.url ?? ""}
          onAllowOnce={() => void respondToApproval?.({ approved: true })}
          onDeny={() => void respondToApproval?.({ approved: false })}
        />
      );
    }

    if (approval?.approved === false) {
      return (
        <p className="text-muted-foreground my-2 text-sm">
          Du avslo å åpne {domainOf(args?.url ?? "")}.
        </p>
      );
    }

    if (status.type === "running") {
      return (
        <p className="text-muted-foreground my-2 text-sm">
          Leser {domainOf(args?.url ?? "")} …
        </p>
      );
    }

    return null;
  },
});

export function MayaToolUIs() {
  return (
    <>
      <WebSearchToolUI />
      <ShowWebsiteToolUI />
      <CreateFileToolUI />
      <DraftEmailToolUI />
      <CalendarEventToolUI />
      <FetchUrlToolUI />
    </>
  );
}
