import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { WidgetChat } from "@/components/widget/widget-chat";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { greetingFor, profileForWidget } from "@/server/widget/sessions";

export async function generateMetadata({ params }: PageProps<"/w/[key]">): Promise<Metadata> {
  const { key } = await params;
  const profile = await profileForWidget(getServiceRoleClient(), key);
  return {
    title: profile?.name ? `Send forespørsel til ${profile.name}` : "Send forespørsel",
    robots: { index: false, follow: false },
  };
}

/**
 * The widget's own page: inside the iframe on a business's website, or on
 * its own as a direct link. Customers have no account; the conversation is
 * theirs through the session id in their browser.
 */
export default async function WidgetPage({ params, searchParams }: PageProps<"/w/[key]">) {
  const { key } = await params;
  const query = await searchParams;
  const profile = await profileForWidget(getServiceRoleClient(), key);
  if (!profile) notFound();

  return (
    <WidgetChat
      widgetKey={key}
      embedded={query.embed === "1"}
      origin={typeof query.origin === "string" ? query.origin : null}
      business={{
        name: profile.name || "Bedriften",
        greeting: greetingFor(profile),
        color: profile.widgetColor,
        area: profile.serviceArea,
      }}
    />
  );
}
