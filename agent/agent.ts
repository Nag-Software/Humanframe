import { defineAgent } from "eve";

export default defineAgent({
  // The MVP has no sandbox, so the sandbox-backed defaults (bash, read_file,
  // write_file, …) stay off. The tools Maya needs are authored in agent/tools/.
  defaultTools: false,
  // Gateway model id: Vercel OIDC in preview and production, AI_GATEWAY_API_KEY
  // as the local fallback. eve owns this value — change it with
  // `eve set --model <id>` or `/model <id>` in the dev TUI, both of which
  // rewrite the literal below. It is read when the manifest is compiled, so a
  // change needs a rebuild either way.
  model: "minimax/minimax-m2.7",
});
