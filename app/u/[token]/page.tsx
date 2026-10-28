import type { Metadata } from "next";

import { LogoMark } from "@/components/hf/logo";
import { UploadForm } from "@/components/receptionist/upload-form";
import { formatMessage, getTranslations } from "@/lib/i18n";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { resolveUploadLink } from "@/server/receptionist/uploads";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t.receptionist.upload.metaTitle, robots: { index: false, follow: false } };
}

/**
 * The page a caller opens from the SMS. No account, no app: choose photos,
 * send. The token in the URL is the whole credential.
 */
export default async function UploadPage({ params }: PageProps<"/u/[token]">) {
  const { token } = await params;
  const t = await getTranslations();
  const copy = t.receptionist.upload;
  const link = await resolveUploadLink(getServiceRoleClient(), token);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-6">
      <div className="bg-card shadow-lift w-full max-w-sm space-y-6 rounded-3xl p-7">
        {link ? (
          <>
            <div className="space-y-2">
              <h1 className="font-serif text-[2rem] leading-[1.05] tracking-[-0.02em]">
                {formatMessage(copy.title, { name: link.businessName || "oss" })}
              </h1>
              <p className="text-muted-foreground text-sm leading-relaxed">{copy.description}</p>
            </div>
            <UploadForm token={token} remaining={Math.max(0, link.maxFiles - link.filesSoFar)} />
          </>
        ) : (
          <p className="text-sm">{copy.expired}</p>
        )}
      </div>
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <LogoMark className="size-3.5" /> Drevet av Humanframe
      </p>
    </main>
  );
}
