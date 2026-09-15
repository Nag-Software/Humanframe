"use client"

import { useEffect, useState } from "react"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { ConnectorAccount } from "@/server/connectors/accounts"
import { Button } from "@/components/ui/button"
import { useTranslations } from "@/components/i18n-provider"

type ConnectorStatus = {
  provider: "gmail" | "outlook"
  account?: ConnectorAccount
  isLoading: boolean
  error?: string
}

export function ConnectorStatus() {
  const t = useTranslations()
  const copy = t.settings.connections
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([
    { provider: "gmail", isLoading: true },
    { provider: "outlook", isLoading: true },
  ])

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const res = await fetch("/api/connectors/accounts")
        if (!res.ok) {
          throw new Error("Failed to fetch accounts")
        }
        const data = (await res.json()) as { accounts: ConnectorAccount[] }

        const accountsByProvider = new Map<string, ConnectorAccount>()
        for (const account of data.accounts) {
          accountsByProvider.set(account.provider, account)
        }

        setConnectors((prev) =>
          prev.map((connector) => ({
            ...connector,
            isLoading: false,
            account: accountsByProvider.get(connector.provider),
          }))
        )
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : copy.loadAccountsFailed
        setConnectors((prev) =>
          prev.map((connector) => ({
            ...connector,
            isLoading: false,
            error: errorMsg,
          }))
        )
      }
    }

    fetchAccounts()
  }, [copy])

  return (
    <div className="flex flex-col gap-3">
      {connectors.map((connector) => (
        <ConnectorCard key={connector.provider} connector={connector} t={t} />
      ))}
    </div>
  )
}

function ConnectorCard({
  connector,
  t,
}: {
  connector: ConnectorStatus
  t: Dictionary
}) {
  const copy = t.settings.connections
  const providerName =
    connector.provider === "gmail" ? copy.gmail : copy.outlook
  const isConnected = connector.account && connector.account.status === "active"
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)

  const handleConnect = async () => {
    if (isConnecting) return
    setIsConnecting(true)

    try {
      const res = await fetch("/api/connectors/auth-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: connector.provider }),
      })

      if (!res.ok) {
        throw new Error("Failed to create authorization link")
      }

      const data = (await res.json()) as {
        redirectUrl?: string
        alreadyConnected?: boolean
      }
      if (data.redirectUrl) {
        window.location.href = data.redirectUrl
        return
      }
      window.location.reload()
    } catch (error) {
      console.error("Failed to connect:", error)
      alert("Failed to create connection link")
      setIsConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    if (!connector.account) return

    if (!window.confirm(copy.disconnectConfirm)) {
      return
    }

    setIsDisconnecting(true)
    try {
      const res = await fetch(
        `/api/connectors/disconnect/${connector.account.id}`,
        { method: "POST" }
      )
      if (!res.ok) {
        throw new Error("Failed to disconnect")
      }
      // Refetch the accounts
      window.location.reload()
    } catch (error) {
      console.error("Failed to disconnect:", error)
      alert("Failed to disconnect account")
      setIsDisconnecting(false)
    }
  }

  if (connector.isLoading) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-border/60 p-4 animate-pulse">
        <div className="space-y-1 flex-1">
          <div className="h-4 w-20 bg-muted rounded" />
          <div className="h-3 w-32 bg-muted rounded mt-1" />
        </div>
        <div className="h-9 w-20 bg-muted rounded" />
      </div>
    )
  }

  if (connector.error) {
    return (
      <div className="rounded-xl border border-border/60 p-4 bg-destructive/5">
        <p className="text-sm text-destructive">{connector.error}</p>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between rounded-xl border border-border/60 p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{providerName}</p>
        {isConnected ? (
          <>
            <p className="text-xs text-green-600">{copy.connected}</p>
            {connector.account?.accountEmail && (
              <p className="text-xs text-muted-foreground">
                {connector.account.accountEmail}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{copy.notConnected}</p>
        )}
      </div>
      <Button
        size="sm"
        variant={isConnected ? "outline" : "secondary"}
        onClick={isConnected ? handleDisconnect : handleConnect}
        disabled={isDisconnecting || isConnecting}
      >
        {isConnecting && !isConnected
          ? copy.connecting
          : isDisconnecting && isConnected
            ? copy.disconnecting
            : isConnected
              ? copy.disconnect
              : copy.connect}
      </Button>
    </div>
  )
}
