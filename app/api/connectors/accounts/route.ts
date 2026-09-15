import { listAccounts } from "@/server/connectors/accounts"
import { getRequestScope } from "@/server/db/request-scope"
import { NextResponse } from "next/server"

export async function GET() {
  try {
    const scope = await getRequestScope()
    if (!scope) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const accounts = await listAccounts({
      workspaceId: scope.workspaceId,
      userId: scope.userId,
    })

    return NextResponse.json({ accounts })
  } catch (error) {
    console.error("Failed to fetch connector accounts:", error)
    return NextResponse.json(
      { error: "Failed to fetch accounts" },
      { status: 500 }
    )
  }
}
