"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getTranslations } from "@/lib/i18n";
import { getRequestScope } from "@/server/db/request-scope";

/**
 * Whether Maya may go beyond the plan's minutes, and up to how much.
 *
 * Written as the signed-in person: the row's policy only lets an owner or
 * admin change what the workspace is willing to pay, so a member's form
 * submission is refused by the database, not by this file.
 */
const schema = z.object({
  allowOverage: z.boolean(),
  overageCapUsd: z.number().min(0).max(100_000).nullable(),
});

export type UsageFormState = { ok: boolean; message?: string };

export async function saveUsageSettings(
  _previous: UsageFormState,
  formData: FormData
): Promise<UsageFormState> {
  const t = await getTranslations();
  const copy = t.settings.usage;
  const scope = await getRequestScope();
  if (!scope) {
    return { ok: false, message: copy.signInRequired };
  }

  const rawCap = formData.get("overageCapUsd");
  const capText = typeof rawCap === "string" ? rawCap.trim() : "";
  const parsed = schema.safeParse({
    allowOverage: formData.get("allowOverage") === "on",
    overageCapUsd: capText === "" ? null : Number(capText.replace(",", ".")),
  });

  if (!parsed.success) {
    return { ok: false, message: copy.invalid };
  }

  const { error } = await scope.client.from("usage_settings").upsert(
    {
      workspace_id: scope.workspaceId,
      allow_overage: parsed.data.allowOverage,
      overage_cap_cents:
        parsed.data.overageCapUsd === null
          ? null
          : Math.round(parsed.data.overageCapUsd * 100),
      updated_by: scope.userId,
    },
    { onConflict: "workspace_id" }
  );

  if (error) {
    return { ok: false, message: copy.saveFailed };
  }

  revalidatePath("/", "layout");
  return { ok: true, message: copy.saved };
}
