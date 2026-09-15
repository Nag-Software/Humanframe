"use client";

import Image from "next/image";
import { ThreadPrimitive } from "@assistant-ui/react";

import { useTranslations } from "@/components/i18n-provider";

export function MayaWelcome() {
  const t = useTranslations();
  const starters = [
    t.maya.starters.news,
    t.maya.starters.email,
    t.maya.starters.agenda,
  ];

  return (
    <div className="mb-8 flex flex-col items-center gap-5 px-4 text-center">
      <Image
        src="/assistants/maya.png"
        alt=""
        width={64}
        height={64}
        className="size-16 rounded-full object-cover"
        priority
      />

      <div className="space-y-1">
        <h1 className="text-2xl font-medium tracking-tight">{t.maya.greeting}</h1>
        <p className="text-muted-foreground text-sm">{t.maya.tagline}</p>
      </div>

      <div className="flex w-full max-w-md flex-col gap-2">
        {starters.map((prompt) => (
          <ThreadPrimitive.Suggestion
            key={prompt}
            prompt={prompt}
            send
            className="border-border/60 hover:bg-muted/60 rounded-xl border px-3.5 py-2.5 text-start text-sm transition-colors"
          >
            {prompt}
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
}
