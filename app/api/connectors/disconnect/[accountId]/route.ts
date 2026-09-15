import { disconnectAccount } from "@/server/connectors/accounts"
import { getRequestScope } from "@/server/db/request-scope"
import { NextResponse } from "next/server"

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const scope = await getRequestScope()
    if (!scope) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { accountId } = await params

    const account = await disconnectAccount({
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      accountId,
    })

    if (!account) {
      return NextResponse.json(
        { error: "Account not found" },
        { status: 404 }
      )
    }

    return NextResponse.json({ account })
  } catch (error) {
    console.error("Failed to disconnect account:", error)
    return NextResponse.json(
      { error: "Failed to disconnect account" },
      { status: 500 }
    )
  }
}
