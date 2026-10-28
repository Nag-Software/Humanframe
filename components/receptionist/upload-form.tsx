"use client";

import { useState } from "react";

import { useTranslations } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { formatMessage } from "@/lib/i18n/dictionaries";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function UploadForm({ token, remaining }: { token: string; remaining: number }) {
  const copy = useTranslations().receptionist.upload;
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [stored, setStored] = useState(0);

  async function send() {
    setState("sending");
    const chosen = files.slice(0, remaining);
    const endpoint = `/api/public/uploads/${encodeURIComponent(token)}`;
    try {
      const prepared = (await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          step: "prepare",
          files: chosen.map((file) => ({ name: file.name, type: file.type, size: file.size })),
        }),
      }).then((response) => response.json())) as {
        uploads?: { name: string; path: string; token: string }[];
      };

      // Straight to storage with the signed token; the bytes never pass
      // through our functions.
      const storage = createSupabaseBrowserClient().storage.from("inquiry-files");
      const uploaded: { path: string; name: string }[] = [];
      for (const upload of prepared.uploads ?? []) {
        const file = chosen.find((candidate) => candidate.name === upload.name);
        if (!file) continue;
        const { error } = await storage.uploadToSignedUrl(upload.path, upload.token, file, {
          contentType: file.type,
        });
        if (!error) uploaded.push({ path: upload.path, name: upload.name });
      }

      const confirmed = uploaded.length
        ? ((await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ step: "confirm", files: uploaded }),
          }).then((response) => response.json())) as { stored?: number })
        : { stored: 0 };

      const count = confirmed.stored ?? 0;
      setStored((value) => value + count);
      setState(count === chosen.length ? "done" : "error");
      setFiles([]);
    } catch {
      setState("error");
    }
  }

  return (
    <div className="space-y-4">
      <label className="border-border hover:bg-muted/40 flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-center">
        <span className="text-sm font-medium">{copy.choose}</span>
        <span className="text-muted-foreground text-xs">{copy.limit}</span>
        <input
          type="file"
          multiple
          accept="image/*,application/pdf,video/mp4,video/quicktime"
          className="sr-only"
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
      </label>

      {files.length > 0 ? (
        <ul className="text-muted-foreground space-y-1 text-xs">
          {files.map((file) => (
            <li key={`${file.name}-${file.size}`} className="truncate">
              {file.name}
            </li>
          ))}
        </ul>
      ) : null}

      <Button
        className="h-10 w-full"
        disabled={files.length === 0 || state === "sending" || remaining === 0}
        onClick={() => void send()}
      >
        {state === "sending" ? copy.sending : copy.send}
      </Button>

      {stored > 0 ? (
        <p role="status" className="text-sm">
          {formatMessage(copy.done, { count: stored })}
        </p>
      ) : null}
      {state === "error" ? (
        <p role="status" className="text-destructive text-sm">
          {copy.failed}
        </p>
      ) : null}
    </div>
  );
}
