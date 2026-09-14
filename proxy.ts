import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

// `middleware.ts` was renamed to `proxy.ts` in Next.js 16.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and image optimization.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)",
  ],
};
