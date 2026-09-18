"use client";

import { ThreadPrimitive } from "@assistant-ui/react";

import { useTranslations } from "@/components/i18n-provider";
import { ParticleField } from "@/components/maya/presence/particle-field";

export function MayaWelcome() {
  const t = useTranslations();
  const starters = [
    t.maya.starters.news,
    t.maya.starters.email,
    t.maya.starters.agenda,
  ];

  return (
    <div className="mb-8 flex flex-col items-center gap-5 px-4 text-center">
      <ParticleField size={220} mode="idle" className="text-foreground -my-8" />

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
