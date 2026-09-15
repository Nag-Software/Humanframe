import { defineAgent } from "eve";

export default defineAgent({
  // The MVP has no sandbox, so the sandbox-backed defaults (bash, read_file,
  // write_file, …) stay off. The tools Maya needs are authored in agent/tools/.
  defaultTools: false,
  // Gateway model id: Vercel OIDC in preview and production, AI_GATEWAY_API_KEY
  // as the local fallback. MAYA_MODEL overrides it, but eve reads the agent
  // config when it builds the manifest, so a change needs a rebuild/redeploy.
  model: process.env.MAYA_MODEL ?? "openai/gpt-5-nano",
});
