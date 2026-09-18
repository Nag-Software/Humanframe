import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { publicEnv } from "@/lib/env";

// `/eve` is the agent runtime's own surface: it runs its own auth walk (see
// agent/channels/eve.ts) and its health route is deliberately public.
// `/internal` is Humanframe calling itself — it authenticates with a Vercel
// OIDC token, not a browser session, so a redirect to /login would break it
// while proving nothing. The route runs its own, stricter check.
// `/api/billing/webhook` is Stripe calling us: no browser session, and the
// route proves the caller with the webhook signature instead.
const PUBLIC_PATHS = [
  "/login",
  "/auth",
  "/eve",
  "/internal",
  "/api/billing/webhook",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

/**
 * Refreshes the Supabase session cookie and keeps unauthenticated traffic out
 * of the app. This is an optimistic gate — every route and API handler still
 * resolves the user itself.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublicPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  }

  if (user && request.nextUrl.pathname === "/login") {
    const rawNext = request.nextUrl.searchParams.get("next");
    const next =
      rawNext?.startsWith("/") && !rawNext.startsWith("//")
        ? rawNext
        : "/assistants/maya";
    return NextResponse.redirect(new URL(next, request.nextUrl.origin));
  }

  return response;
}
