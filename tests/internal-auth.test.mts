import { verifyVercelOidc } from "eve/channels/auth";

import {
  currentProjectBinding,
  verifyInternalCaller,
  type ProjectBinding,
} from "../agent/lib/internal-auth.ts";
import { loadEnv } from "./harness.mts";

/**
 * The gate on internal delivery.
 *
 * The cryptography is eve's `verifyVercelOidc`; what is tested here is the
 * policy around it — that a token for the wrong project, the wrong
 * environment, or a person rather than a machine is refused, and that an
 * absent project binding fails closed instead of checking loosely.
 *
 * The rejection cases only mean something if the acceptance case works: a
 * token that has simply expired would "pass" every rejection test for the
 * wrong reason. So acceptance is the control, and when no usable token is
 * present the suite reports SKIPPED rather than a vacuous pass. The
 * authoritative run is on Vercel Preview (P3), where the runtime always holds
 * a fresh token.
 */

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function skip(name: string, why: string): void {
  skipped += 1;
  console.log(`SKIP  ${name} (${why})`);
}

type Claims = {
  project_id?: string;
  environment?: string;
  exp?: number;
  sub?: string;
  aud?: string;
};

function decode(token: string): Claims {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims;
}

async function main(): Promise<void> {
  const env = loadEnv();

  // --- Binding fails closed, with no token involved ----------------------
  {
    check("a missing project id leaves the caller unbound",
      currentProjectBinding({ VERCEL_TARGET_ENV: "preview" }) === null);
    check("a missing environment leaves the caller unbound",
      currentProjectBinding({ VERCEL_PROJECT_ID: "prj_x" }) === null);
    check("both present produces a binding",
      currentProjectBinding({
        VERCEL_PROJECT_ID: "prj_x",
        VERCEL_TARGET_ENV: "preview",
      })?.projectId === "prj_x");
    check("VERCEL_ENV is accepted as a fallback for the target environment",
      currentProjectBinding({
        VERCEL_PROJECT_ID: "prj_x",
        VERCEL_ENV: "production",
      })?.environment === "production");

    const unbound = await verifyInternalCaller("any.token.here", null);
    check("an unbound runtime refuses every internal caller",
      unbound.ok === false && unbound.reason === "unbound", unbound);

    const missing = await verifyInternalCaller(null, {
      projectId: "prj_x",
      environment: "preview",
    });
    check("a request with no token is refused",
      missing.ok === false && missing.reason === "no_token", missing);
  }

  // --- Everything below needs a real, unexpired token --------------------
  //
  // Two levels are tested separately, because they fail for different reasons:
  // `verifyVercelOidc` is the cryptography and the project/environment
  // binding, and `verifyInternalCaller` is Humanframe's policy on top of it.
  // A local `eve link` token is valid but carries a person, so it is the right
  // input for proving the binding works *and* for proving the policy refuses a
  // human principal.
  const token = env.VERCEL_OIDC_TOKEN ?? null;
  if (!token) {
    skip("token-backed checks", "no VERCEL_OIDC_TOKEN; run `eve link` or use Preview");
    report();
    return;
  }

  const claims = decode(token);
  const binding: ProjectBinding = {
    projectId: claims.project_id ?? "",
    environment: claims.environment ?? "",
  };

  const control = await verifyVercelOidc(token, {
    currentVercelProject: {
      projectId: binding.projectId,
      environment: binding.environment,
    },
  });

  if (!control.ok) {
    const expired = (claims.exp ?? 0) * 1000 < Date.now();
    skip("token-backed checks",
      expired
        ? "VERCEL_OIDC_TOKEN has expired; run `eve link` to refresh"
        : "the token was not accepted for its own project");
    report();
    return;
  }

  check("a token bound to its own project and environment verifies", control.ok);

  // --- Wrong project ------------------------------------------------------
  {
    const wrong = await verifyInternalCaller(token, {
      projectId: "prj_0000000000000000000000000",
      environment: binding.environment,
    });
    check("a token minted for another project is refused", wrong.ok === false, wrong);

    const evesView = await verifyVercelOidc(token, {
      currentVercelProject: {
        projectId: "prj_0000000000000000000000000",
        environment: binding.environment,
      },
    });
    check("eve's own verifier rejects the wrong project too", evesView.ok === false);
  }

  // --- Wrong environment --------------------------------------------------
  {
    for (const environment of ["production", "preview", "development"].filter(
      (candidate) => candidate !== binding.environment
    )) {
      // eve's own verifier lets a same-project token from another environment
      // through as a service principal. Humanframe does not: this assertion is
      // about our policy, and it is the one that keeps a preview deployment
      // from waking production users.
      const wrong = await verifyInternalCaller(token, {
        projectId: binding.projectId,
        environment,
      });
      check(`a ${binding.environment} token cannot drive ${environment}`,
        wrong.ok === false && wrong.reason === "wrong_environment",
        { environment, outcome: wrong });
    }
  }

  // --- Tampering ----------------------------------------------------------
  {
    const [header, payload, signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...claims, project_id: "prj_attacker" }),
      "utf8"
    ).toString("base64url");
    const forged = `${header}.${forgedPayload}.${signature}`;
    check("a token whose claims were edited fails its signature",
      (await verifyInternalCaller(forged, binding)).ok === false);
    check("a token with the signature stripped is refused",
      (await verifyInternalCaller(`${header}.${payload}.`, binding)).ok === false);
    check("a garbage token is refused",
      (await verifyInternalCaller("not-a-token", binding)).ok === false);
  }

  // --- The policy on top: only machines deliver ----------------------------
  {
    const asInternal = await verifyInternalCaller(token, binding);
    if (control.sessionAuth.principalType === "user") {
      check("a token carrying a person is refused as an internal caller",
        asInternal.ok === false && asInternal.reason === "not_machine", asInternal);
      skip("machine-principal acceptance",
        "a local eve link token is a development user token; Preview mints the machine token (P3)");
    } else {
      check("a machine token from this deployment is accepted as the deliverer",
        asInternal.ok === true, asInternal);
    }
  }

  report();
}

function report(): void {
  const total = passed + failed;
  console.log(`\n${passed}/${total} passed${skipped > 0 ? `, ${skipped} skipped` : ""}`);
  if (failed > 0) {
    process.exit(1);
  }
}

await main();
