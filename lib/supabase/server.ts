import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;

/** Sant når Supabase er konfigurert. Uten det kjører chatten uten lagring. */
export const isSupabaseConfigured = Boolean(url && serviceKey);

let cached: SupabaseClient | null = null;

/**
 * Server-side Supabase-klient. Returnerer null når prosjektet ikke er
 * konfigurert, slik at chatten fungerer uten database i utvikling.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (!isSupabaseConfigured) {
    return null;
  }
  cached ??= createClient(url as string, serviceKey as string, {
    auth: { persistSession: false },
  });
  return cached;
}

export const MAYA_BUCKET = "maya-attachments";
