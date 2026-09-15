import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}
const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const { data } = await admin.from("users").select("id, email").eq("email", "casper@nagsoftware.no").maybeSingle();
console.log("humanframe user:", JSON.stringify(data));

const { Composio } = await import("@composio/core");
const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
const session = await composio.create(data!.id);

const request: any = await session.authorize("gmail", { authConfigId: "ac_LJFDmP9JE1U6" });
console.log("\nconnection request id:", request.id ?? request.connectedAccountId ?? "(n/a)");
console.log("REDIRECT URL:\n" + (request.redirectUrl ?? request.redirect_url));
