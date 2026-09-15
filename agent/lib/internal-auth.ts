import { type AuthFn, verifyVercelOidc } from "eve/channels/auth";

/**
 * Authentication for Humanframe's own internal callers.
 *
 * The deliverer wakes Maya by posting a message to an existing eve session
 * over HTTP, and that request has to prove it came from this deployment. eve's
 * `verifyVercelOidc` does the cryptography — signature against the issuer's
 * JWKS, `iss`, `aud`, `exp`/`nbf` — and binds the token to one project and one
 * environment. This module adds the policy on top:
 *
 *  - the project and environment binding is passed **explicitly**, never left
 *    to whatever happens to be in the environment, so a missing variable fails
 *    closed instead of widening the check;
 *  - only machine principals are accepted. A token carrying an end user
 *    (`user_id` in development, `external_sub` for a connector) is not an
 *    internal caller, whatever project it came from;
 *  - the principal carries **no scope**. Workspace, assistant, user and thread
 *    are read from the stored commitment, never from the caller. A caller can
 *    prove it is us; it cannot choose whose data it acts on.
 */

export const INTERNAL_PRINCIPAL_ID = "humanframe:deliverer";

export type ProjectBinding = {
  projectId: string;
  environment: string;
};

export type InternalAuthOutcome =
  | { ok: true; principalType: "runtime" | "service" }
  | {
      ok: false;
      reason:
        | "no_token"
        | "unbound"
        | "rejected"
        | "not_machine"
        | "wrong_project"
        | "wrong_environment";
    };

/**
 * The project and environment this code is running as. Fails closed: without
 * both, there is nothing to bind a token to, and every internal request is
 * refused rather than checked loosely.
 */
export function currentProjectBinding(
  env: Readonly<Record<string, string | undefined>> = process.env
): ProjectBinding | null {
  const projectId = env.VERCEL_PROJECT_ID;
  const environment = env.VERCEL_TARGET_ENV ?? env.VERCEL_ENV;
  if (!projectId || !environment) {
    return null;
  }
  return { projectId, environment };
}

/** The token to present, read fresh at call time and never stored. */
export function readInternalToken(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  return env.VERCEL_OIDC_TOKEN ?? null;
}

export async function verifyInternalCaller(
  token: string | null,
  binding: ProjectBinding | null
): Promise<InternalAuthOutcome> {
  if (!token) {
    return { ok: false, reason: "no_token" };
  }
  if (!binding) {
    return { ok: false, reason: "unbound" };
  }

  const result = await verifyVercelOidc(token, {
    currentVercelProject: {
      projectId: binding.projectId,
      environment: binding.environment,
    },
  });

  if (!result.ok) {
    return { ok: false, reason: "rejected" };
  }

  // eve binds the token to the project, but deliberately allows a same-project
  // token from another environment through as a `service` principal. For
  // delivery that is too wide: a preview deployment must not be able to wake
  // users in production, and a development token must not drive either. The
  // claims are safe to read here — the signature has already been verified.
  const claims = readClaims(token);
  if (!claims) {
    return { ok: false, reason: "rejected" };
  }
  if (claims.project_id !== binding.projectId) {
    return { ok: false, reason: "wrong_project" };
  }
  if (claims.environment !== binding.environment) {
    return { ok: false, reason: "wrong_environment" };
  }

  const principalType = result.sessionAuth.principalType;
  if (principalType !== "runtime" && principalType !== "service") {
    // A token that carries a person is not this deployment calling itself.
    return { ok: false, reason: "not_machine" };
  }

  return { ok: true, principalType };
}

type InternalTokenClaims = {
  project_id?: unknown;
  environment?: unknown;
};

/** Reads the payload of an already-verified token. Never used to authenticate. */
function readClaims(token: string): { project_id: string; environment: string } | null {
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as InternalTokenClaims;
    if (
      typeof claims.project_id !== "string" ||
      typeof claims.environment !== "string"
    ) {
      return null;
    }
    return { project_id: claims.project_id, environment: claims.environment };
  } catch {
    return null;
  }
}

/**
 * The auth walk entry. Placed ahead of `vercelOidc()` so an internal caller is
 * recognised as the deliverer rather than as a generic Vercel principal, and
 * so the scope-free service identity is the one the session sees.
 */
export function internalDeployment(): AuthFn<Request> {
  return async (request) => {
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) {
      return null;
    }
    if (request.headers.get("x-humanframe-internal") !== "delivery") {
      // Not claiming to be us: let the rest of the walk handle it.
      return null;
    }

    const outcome = await verifyInternalCaller(
      header.slice("Bearer ".length),
      currentProjectBinding()
    );
    if (!outcome.ok) {
      return null;
    }

    return {
      authenticator: "internal",
      principalId: INTERNAL_PRINCIPAL_ID,
      principalType: "service",
      attributes: {},
    };
  };
}
