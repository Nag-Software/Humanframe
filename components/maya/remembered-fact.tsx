"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { XIcon } from "lucide-react";

import { useTranslations } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";
import type { RememberedFact } from "@/server/db/repositories/memory";

/**
 * One thing she remembers, and the way to take it away. Correcting a fact is
 * done in conversation — "actually, it's two engineers" — which is how you
 * would correct a person; this is only the ✕.
 */
export function RememberedFactRow({ fact }: { fact: RememberedFact }) {
  const t = useTranslations();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function forget() {
    setBusy(true);
    try {
      const response = await fetch(`/api/assistants/maya/memory/${fact.id}`, {
        method: "DELETE",
      });
      if (response.ok || response.status === 404) {
        router.refresh();
        return;
      }
    } catch {
      // The row is still there; the button comes back.
    }
    setBusy(false);
  }

  return (
    <div
      className={cn(
        "group border-border/60 flex items-center gap-3 border-t py-3 text-sm transition-opacity",
        busy && "opacity-50"
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="text-muted-foreground">{fact.attribute}</span>
        <span className="text-muted-foreground"> · </span>
        {fact.value}
      </span>
      <button
        type="button"
        aria-label={t.maya.profile.forget}
        title={t.maya.profile.forget}
        disabled={busy}
        onClick={() => void forget()}
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
