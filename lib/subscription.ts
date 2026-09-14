/**
 * Product plans shown in the shell. Billing is not persisted yet, so the app
 * defaults every workspace to Free until a `plan` column (or subscriptions
 * table) exists.
 */
export const PLAN_IDS = ["free", "pro"] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export const DEFAULT_PLAN: PlanId = "free";

export function isPlanId(value: string | null | undefined): value is PlanId {
  return value === "free" || value === "pro";
}
