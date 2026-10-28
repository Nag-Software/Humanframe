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
// `/api/telephony` is Twilio and OpenAI calling us about phone calls and SMS;
// every route there verifies the provider's signature.
// `/api/cron` is Vercel Cron, proven by CRON_SECRET.
// `/u` and `/api/public` are the photo-upload page a caller opens from an SMS,
// and `/api/calendar/feed` is the owner's calendar app fetching bookings. All
// three are proven by an unguessable token in the path, not by a session.
const PUBLIC_PATHS = [
  "/login",
  "/auth",
  "/eve",
  "/internal",
  "/api/billing/webhook",
  "/api/telephony",
  "/api/cron",
  "/u",
  "/api/public",
  "/api/calendar/feed",
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

  // A signed-in user on /login is sent on — unless the login page is there to
  // explain an error. Bouncing that user to the app, whose layout sends them
  // back to /login when they have no workspace, was a redirect loop.
  if (
    user &&
    request.nextUrl.pathname === "/login" &&
    !request.nextUrl.searchParams.has("error")
  ) {
    const rawNext = request.nextUrl.searchParams.get("next");
    const next =
      rawNext?.startsWith("/") && !rawNext.startsWith("//")
        ? rawNext
        : "/assistants/maya";
    return NextResponse.redirect(new URL(next, request.nextUrl.origin));
  }

  return response;
}
