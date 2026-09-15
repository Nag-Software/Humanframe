import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}
const { Composio } = await import("@composio/core");
const c = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
const a: any = await c.connectedAccounts.get("ca_AcZGv48z155B");
console.log("top-level keys:", Object.keys(a).join(", "));
console.log("user fields:", JSON.stringify({
  userId: a.userId, user_id: a.user_id, uuid: a.uuid,
  entityId: a.entityId, data_keys: a.data ? Object.keys(a.data) : null,
}));
