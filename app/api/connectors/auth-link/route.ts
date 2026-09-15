import { beginAuthorization } from "@/server/connectors/accounts"
import { createAuthorizationLink, type EmailProvider } from "@/server/connectors/composio"
import { getRequestScope } from "@/server/db/request-scope"
import { NextResponse } from "next/server"

export async function POST(request: Request) {
  try {
    const scope = await getRequestScope()
    if (!scope) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { provider } = (await request.json()) as { provider: EmailProvider }

    if (!provider || !["gmail", "outlook"].includes(provider)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 })
    }

    const state = await beginAuthorization({
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      provider,
    })

    const { appOrigin } = await import("@/agent/lib/email-template")
    const origin = appOrigin(process.env)

    const { redirectUrl } = await createAuthorizationLink({
      provider,
      composioUserId: scope.userId,
      callbackUrl: `${origin}/api/connectors/callback?state=${state}`,
    })

    return NextResponse.json({ redirectUrl })
  } catch (error) {
    console.error("Failed to create authorization link:", error)
    return NextResponse.json(
      { error: "Failed to create authorization link" },
      { status: 500 }
    )
  }
}
