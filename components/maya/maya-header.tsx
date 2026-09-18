"use client";

import Image from "next/image";
import Link from "next/link";
import { useAuiState } from "@assistant-ui/react";
import { PhoneIcon, VideoIcon } from "lucide-react";

import { useLocale, useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { formatMessage } from "@/lib/i18n/dictionaries";
import { formatDueWhen } from "@/lib/i18n/format";

export type MayaCallHandlers = {
  onVoiceCall?: () => void;
  onVideoCall?: () => void;
};

/** The one thing she will come back to first. */
export type Holding = {
  title: string;
  dueAt: string;
} | null;

/**
 * The presence bar. This is where she is: her face, her name and what she is
 * doing or holding for you — never a category label. Call and FaceTime are
 * the point of the product, so they get words, not ghost icons.
 */
export function MayaHeader({
  onVoiceCall,
  onVideoCall,
  holding,
  live,
}: MayaCallHandlers & {
  holding: Holding;
  /** True when rendered inside the chat runtime, so the running state is known. */
  live: boolean;
}) {
  const t = useTranslations();

  return (
    <header className="border-border/60 bg-background/80 flex h-16 shrink-0 items-center gap-3 border-b px-3 backdrop-blur">
      <SidebarTrigger className="text-muted-foreground" />

      <Link
        href="/assistants/maya/profile"
        className="flex min-w-0 flex-1 items-center gap-3.5 rounded-xl py-1 pr-2"
      >
        <Image
          src="/assistants/maya-avatar.png"
          alt=""
          width={40}
          height={40}
          className="size-10 shrink-0 rounded-full object-cover"
        />
        <span className="min-w-0 leading-tight">
          <span className="font-display block truncate text-base font-semibold tracking-tight">
            {t.nav.maya}
          </span>
          <span className="text-muted-foreground block truncate text-[13px]">
            {live ? <LiveState holding={holding} /> : <HoldingState holding={holding} />}
          </span>
        </span>
      </Link>

      <div className="flex items-center gap-2">
        <Button
          size="lg"
          disabled={!onVoiceCall}
          onClick={onVoiceCall}
          className="bg-call text-call-foreground hover:bg-call/80 rounded-full pr-4 pl-3.5 text-[13px] font-medium"
        >
          <PhoneIcon className="size-4" />
          {t.maya.voiceCall}
        </Button>
        <Button
          size="lg"
          disabled={!onVideoCall}
          onClick={onVideoCall}
          className="bg-call text-call-foreground hover:bg-call/80 rounded-full pr-4 pl-3.5 text-[13px] font-medium"
        >
          <VideoIcon className="size-4" />
          {t.maya.videoCall}
        </Button>
      </div>
    </header>
  );
}

function HoldingState({ holding }: { holding: Holding }) {
  const t = useTranslations();
  const locale = useLocale();

  if (!holding) {
    return <>{t.maya.here}</>;
  }
  return (
    <span suppressHydrationWarning>
      {formatMessage(t.maya.holding, {
        when: formatDueWhen(holding.dueAt, locale),
        title: holding.title,
      })}
    </span>
  );
}

/** Inside the runtime the state line can also say that she is working. */
function LiveState({ holding }: { holding: Holding }) {
  const t = useTranslations();
  const running = useAuiState((s) => s.thread.isRunning);

  if (running) {
    return <>{t.maya.working}</>;
  }
  return <HoldingState holding={holding} />;
}
