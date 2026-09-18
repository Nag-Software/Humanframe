import { PLANS, type PlanId } from "@/lib/plans";

/**
 * Product plans shown in the shell. `workspaces.plan` is the denormalised
 * tier; the minutes and prices behind it live in `lib/plans.ts`.
 */
export type { PlanId } from "@/lib/plans";

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export const DEFAULT_PLAN: PlanId = "starter";

export function isPlanId(value: string | null | undefined): value is PlanId {
  return value === "starter" || value === "pro";
}
