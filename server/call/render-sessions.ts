/**
 * The Tavus conversation id for one FaceTime prototype call.
 *
 * Held in process memory on purpose: this prototype is local-only, and a
 * column would be a production schema change. `next dev` is one process, so
 * start and end see the same map. A Vercel function would not — hang-up
 * would fail to end the Daily room — which is why this is a measured
 * hypothesis, not a hosting conclusion. Going to production means a
 * `render_call_id` column, not this map.
 */

type RenderSession = {
  conversationId: string;
  createdAt: number;
};

const sessions = new Map<string, RenderSession>();

export function rememberRenderSession(
  callSessionId: string,
  conversationId: string
): void {
  sessions.set(callSessionId, { conversationId, createdAt: Date.now() });
}

export function takeRenderSession(callSessionId: string): string | null {
  const row = sessions.get(callSessionId);
  sessions.delete(callSessionId);
  return row?.conversationId ?? null;
}
