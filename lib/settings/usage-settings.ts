import type { SupabaseClient } from "@supabase/supabase-js";

import { DEFAULT_USAGE_SETTINGS, type UsageSettings } from "@/lib/plans";

/**
 * The overage decision, read as whoever is asking. No row means the default:
 * Maya stops at the plan's minutes.
 */
type Row = {
  allow_overage: boolean;
  overage_cap_cents: number | null;
};

export async function loadUsageSettings(
  client: SupabaseClient,
  workspaceId: string
): Promise<UsageSettings> {
  const { data } = await client
    .from("usage_settings")
    .select("allow_overage, overage_cap_cents")
    .eq("workspace_id", workspaceId)
    .maybeSingle<Row>();

  if (!data) {
    return DEFAULT_USAGE_SETTINGS;
  }
  return {
    allowOverage: data.allow_overage,
    overageCapUsd:
      data.overage_cap_cents === null ? null : data.overage_cap_cents / 100,
  };
}
