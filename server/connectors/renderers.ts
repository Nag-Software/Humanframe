/**
 * Renderers this build actually ships.
 *
 * The server chooses the renderer from the register, and it must be one of
 * these names. The model never chooses a component, and neither does any
 * metadata that arrives from a provider — so no remote string can select what
 * runs in the browser.
 */
const RENDERERS = new Set([
  "email.list.v1",
  "email.thread.v1",
  "email.draft.v1",
  "email.send-approval.v1",
  /** Read results that would not normalise; sanitized text only. */
  "connector.fallback.v1",
]);

export function hasRenderer(name: string): boolean {
  return RENDERERS.has(name);
}

export const FALLBACK_RENDERER = "connector.fallback.v1";
