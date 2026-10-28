import { getRequestScope, type RequestScope } from "@/server/db/request-scope";

/** Owners and admins configure the receptionist; members can read and approve. */
export function canConfigure(scope: RequestScope): boolean {
  return scope.workspace.role === "owner" || scope.workspace.role === "admin";
}

export async function requireApiScope(
  options: { configure?: boolean } = {}
): Promise<{ scope: RequestScope } | { response: Response }> {
  const scope = await getRequestScope();
  if (!scope) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  if (options.configure && !canConfigure(scope)) {
    return { response: Response.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { scope };
}
