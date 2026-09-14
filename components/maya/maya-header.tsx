"use client";

import Image from "next/image";
import { PhoneIcon, VideoIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export type MayaCallHandlers = {
  onVoiceCall?: () => void;
  onVideoCall?: () => void;
};

/**
 * Minimal topplinje: avatar, navn, rolle og status til venstre – anrop høyre.
 * Anropsknappene er rene integrasjonspunkter; uten handler er de deaktivert.
 */
export function MayaHeader({ onVoiceCall, onVideoCall }: MayaCallHandlers) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 px-5">
      <span className="relative">
        <Image
          src="/assistants/maya-avatar.png"
          alt=""
          width={32}
          height={32}
          className="size-8 rounded-full object-cover"
        />
        <span
          aria-hidden
          className="border-background absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full border-2 bg-emerald-500"
        />
      </span>

      <div className="min-w-0 leading-tight">
        <p className="truncate text-sm font-medium">Maya</p>
        <p className="text-muted-foreground truncate text-xs">
          AI-assistent · tilgjengelig
        </p>
      </div>

      <div className="ms-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Start taleanrop"
          disabled={!onVoiceCall}
          onClick={onVoiceCall}
        >
          <PhoneIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Start videoanrop"
          disabled={!onVideoCall}
          onClick={onVideoCall}
        >
          <VideoIcon className="size-4" />
        </Button>
      </div>
    </header>
  );
}
