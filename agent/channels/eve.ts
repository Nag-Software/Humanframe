import { createServerClient } from "@supabase/ssr";
import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * Verifies the caller's Supabase session. The eve routes are same-origin
 * (mounted by withEve), so the browser sends the auth cookie with every
 * request and no token plumbing is needed in the client.
 */
function supabaseSession(): AuthFn<Request> {
  return async (request) => {
    const cookieHeader = request.headers.get("cookie");
    if (!cookieHeader) {
      return null;
    }

    // Read at request time, not at module scope: eve compiles this file in a
    // process that has not loaded the app's .env files.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) {
      throw new Error(
        "Supabase environment is missing in the eve runtime: set " +
          "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
      );
    }

    const supabase = createServerClient(
      url,
      key,
      {
        cookies: {
          getAll() {
            return parseCookieHeader(cookieHeader);
          },
          setAll() {
            // Read-only: refreshing the session is the app's proxy's job.
          },
        },
      }
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return null;
    }

    return {
      authenticator: "supabase",
      principalId: user.id,
      principalType: "user",
      attributes: { email: user.email ?? "" },
    };
  };
}

function parseCookieHeader(header: string): { name: string; value: string }[] {
  return header
    .split(";")
    .map((pair) => {
      const index = pair.indexOf("=");
      if (index === -1) {
        return null;
      }
      return {
        name: pair.slice(0, index).trim(),
        value: decodeURIComponent(pair.slice(index + 1).trim()),
      };
    })
    .filter((cookie): cookie is { name: string; value: string } => cookie !== null);
}

// Ordered walk: a real user session first, then Vercel's internal callers, then
// the local dev server. Anything else is rejected — eve fails closed.
export default eveChannel({
  auth: [supabaseSession(), vercelOidc(), localDev()],
});
