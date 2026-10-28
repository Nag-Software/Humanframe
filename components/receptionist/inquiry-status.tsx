"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

export function InquiryStatusButtons({
  inquiryId,
  status,
}: {
  inquiryId: string;
  status: "draft" | "open" | "handled" | "dismissed";
}) {
  const copy = useTranslations().receptionist.inbox;
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function set(next: "open" | "handled" | "dismissed") {
    setBusy(true);
    await fetch(`/api/receptionist/inquiries/${inquiryId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    }).catch(() => undefined);
    setBusy(false);
    router.refresh();
  }

  return status === "open" ? (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" className="rounded-lg" disabled={busy} onClick={() => void set("handled")}>
        {copy.markHandled}
      </Button>
      <Button size="sm" variant="ghost" className="rounded-lg" disabled={busy} onClick={() => void set("dismissed")}>
        {copy.dismiss}
      </Button>
    </div>
  ) : (
    <Button size="sm" variant="outline" className="rounded-lg" disabled={busy} onClick={() => void set("open")}>
      {copy.reopen}
    </Button>
  );
}
