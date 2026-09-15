import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnv } from "./harness.mts";

export type TestWorkspace = {
  userId: string;
  token: string;
  workspaceId: string;
  assistantId: string;
  /** Acts as the user: row level security applies. */
  userClient: SupabaseClient;
  remove(): Promise<void>;
};

const env = loadEnv();

export const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

/** A real signed-up user, with the workspace and Maya the trigger provisions. */
export async function createTestWorkspace(label: string): Promise<TestWorkspace> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const email = `memory-${label}-${Date.now()}@humanframe.test`;
  const password = "Test-1234-aaaa";
  const adminHeaders = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
  };

  const created = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  }).then((response) => response.json());

  const session = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  }).then((response) => response.json());

  const userClient = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { authorization: `Bearer ${session.access_token}` } },
    }
  );

  const { data: membership } = await userClient
    .from("workspace_members")
    .select("workspace_id")
    .limit(1)
    .maybeSingle<{ workspace_id: string }>();

  const { data: assistant } = await userClient
    .from("assistants")
    .select("id")
    .eq("slug", "maya")
    .maybeSingle<{ id: string }>();

  if (!membership || !assistant) {
    throw new Error("provisioning did not create a workspace with Maya");
  }

  return {
    userId: created.id,
    token: session.access_token,
    workspaceId: membership.workspace_id,
    assistantId: assistant.id,
    userClient,
    async remove() {
      await fetch(`${url}/auth/v1/admin/users/${created.id}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
      await admin.from("workspaces").delete().eq("id", membership.workspace_id);
    },
  };
}

/**
 * A deterministic unit vector, so similarity is a property of the test rather
 * than of an embedding model. Axis 0 and axis 1 are orthogonal: cosine
 * similarity between them is 0, and each with itself is 1.
 */
export function unitVector(axis: number, dimensions = 1536): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[axis] = 1;
  return vector;
}

/** A vector between two axes, to test ordering rather than equality. */
export function blendedVector(
  axis: number,
  otherAxis: number,
  weight: number,
  dimensions = 1536
): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[axis] = weight;
  vector[otherAxis] = Math.sqrt(Math.max(0, 1 - weight * weight));
  return vector;
}
