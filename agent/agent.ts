import { defineAgent } from "eve";

export default defineAgent({
  // The MVP has no sandbox, so the sandbox-backed defaults (bash, read_file,
  // write_file, …) stay off. The tools Maya needs are authored in agent/tools/.
  defaultTools: false,
  // Gateway model id: Vercel OIDC in preview and production, AI_GATEWAY_API_KEY
  // as the local fallback. Change it with `eve set --model <id>`.
  model: "inclusionai/ling-3.0-flash-fin",
});
