import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { appOrigin } from "@/agent/lib/email-template";

/**
 * The customer's page for one inquiry. Every message we send a customer
 * carries its link, so the conversation has one place to land: status,
 * quote, accept, pick a time, add photos.
 */

export function portalUrl(token: string): string {
  return `${appOrigin() ?? "http://localhost:3000"}/k/${token}`;
}

export async function ensurePortal(
  admin: SupabaseClient,
  input: { workspaceId: string; inquiryId: string }
): Promise<string> {
  const { data: existing } = await admin
    .from("inquiry_portals")
    .select("token")
    .eq("inquiry_id", input.inquiryId)
    .maybeSingle<{ token: string }>();
  if (existing) return existing.token;

  const token = randomBytes(24).toString("base64url");
  const { error } = await admin.from("inquiry_portals").insert({
    workspace_id: input.workspaceId,
    inquiry_id: input.inquiryId,
    token,
  });
  if (error?.code === "23505") {
    // Someone created it a moment ago; use theirs.
    const { data } = await admin
      .from("inquiry_portals")
      .select("token")
      .eq("inquiry_id", input.inquiryId)
      .single<{ token: string }>();
    if (data) return data.token;
  }
  if (error) throw new Error("Could not create the customer page");
  return token;
}

export async function resolvePortal(
  admin: SupabaseClient,
  token: string
): Promise<{ workspaceId: string; inquiryId: string } | null> {
  if (!/^[A-Za-z0-9_-]{30,40}$/.test(token)) return null;
  const { data } = await admin
    .from("inquiry_portals")
    .select("workspace_id, inquiry_id")
    .eq("token", token)
    .maybeSingle<{ workspace_id: string; inquiry_id: string }>();
  if (!data) return null;
  await admin
    .from("inquiry_portals")
    .update({ last_viewed_at: new Date().toISOString() })
    .eq("token", token);
  return { workspaceId: data.workspace_id, inquiryId: data.inquiry_id };
}

/** Appends the portal link to a customer message unless it is already there. */
export function withPortalLink(body: string, url: string): string {
  if (body.includes(url)) return body;
  return `${body.trimEnd()}\n\nSe saken din: ${url}`;
}
