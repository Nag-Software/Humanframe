import { profileInputSchema, profileReadiness } from "@/server/receptionist/profile";
import { requireApiScope } from "@/server/receptionist/scope";
import { loadProfile, saveProfile } from "@/server/receptionist/store";

export async function GET() {
  const auth = await requireApiScope();
  if ("response" in auth) return auth.response;
  const profile = await loadProfile(auth.scope.client, auth.scope.workspaceId, auth.scope.workspace.name);
  return Response.json({ profile, readiness: profileReadiness(profile) });
}

/** Saves through the user's own client: row level security decides who may. */
export async function PUT(request: Request) {
  const auth = await requireApiScope({ configure: true });
  if ("response" in auth) return auth.response;

  const body = (await request.json().catch(() => null)) as
    | { profile?: unknown; learnedFrom?: string[] }
    | null;
  const parsed = profileInputSchema.safeParse(body?.profile);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      { error: "invalid", field: issue?.path.join("."), message: issue?.message },
      { status: 400 }
    );
  }

  const learnedFrom = Array.isArray(body?.learnedFrom)
    ? body.learnedFrom.filter((url): url is string => typeof url === "string").slice(0, 10)
    : undefined;

  const profile = await saveProfile(auth.scope.client, auth.scope.workspaceId, parsed.data, {
    onboarded: true,
    ...(learnedFrom?.length ? { learnedFrom, learnedAt: new Date().toISOString() } : {}),
  });
  return Response.json({ profile, readiness: profileReadiness(profile) });
}
