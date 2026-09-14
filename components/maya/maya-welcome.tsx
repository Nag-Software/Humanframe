"use client";

import Image from "next/image";
import { ThreadPrimitive } from "@assistant-ui/react";

const STARTERS = [
  "Oppsummer de siste nyhetene om AI i Norge",
  "Skriv et e-postutkast til en ny kunde",
  "Lag et møtereferat som jeg kan laste ned",
];

export function MayaWelcome() {
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
        <h1 className="text-2xl font-medium tracking-tight">Hei, jeg er Maya</h1>
        <p className="text-muted-foreground text-sm">
          Spør om hva som helst – jeg kan søke, skrive og lage filer for deg.
        </p>
      </div>

      <div className="flex w-full max-w-md flex-col gap-2">
        {STARTERS.map((prompt) => (
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
