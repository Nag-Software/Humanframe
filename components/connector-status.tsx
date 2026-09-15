"use client"

import { useEffect, useState } from "react"
import { AlertTriangleIcon, CheckIcon, SearchIcon } from "lucide-react"

import { useTranslations } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ConnectorAccount } from "@/server/connectors/accounts"

const PROVIDERS = ["gmail", "outlook"] as const
type Provider = (typeof PROVIDERS)[number]

type Row = {
  provider: Provider
  account?: ConnectorAccount
}

export function ConnectorStatus() {
  const t = useTranslations()
  const copy = t.settings.connections
  const [query, setQuery] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<ConnectorAccount[] | null>(null)
  const [busy, setBusy] = useState<Provider | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch("/api/connectors/accounts")
        if (!res.ok) throw new Error("failed")
        const data = (await res.json()) as { accounts: ConnectorAccount[] }
        if (!cancelled) {
          setAccounts(data.accounts)
          setError(null)
        }
      } catch {
        if (!cancelled) {
          setError(copy.loadAccountsFailed)
          setAccounts([])
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [copy.loadAccountsFailed])

  const rows: Row[] = PROVIDERS.map((provider) => ({
    provider,
    account: accounts?.find((item) => item.provider === provider),
  }))

  const needle = query.trim().toLowerCase()
  const visible = rows.filter((row) => {
    const name = row.provider === "gmail" ? copy.gmail : copy.outlook
    const haystack = `${name} ${row.account?.accountEmail ?? ""}`.toLowerCase()
    return haystack.includes(needle)
  })

  async function connect(provider: Provider) {
    setBusy(provider)
    try {
      const res = await fetch("/api/connectors/auth-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      })
      if (!res.ok) throw new Error("failed")
      const data = (await res.json()) as { redirectUrl?: string }
      if (data.redirectUrl) {
        window.location.href = data.redirectUrl
        return
      }
      window.location.reload()
    } catch {
      setBusy(null)
      alert(copy.connectFailed)
    }
  }

  async function disconnect(account: ConnectorAccount) {
    if (!window.confirm(copy.disconnectConfirm)) return
    setBusy(account.provider)
    try {
      const res = await fetch(`/api/connectors/disconnect/${account.id}`, {
        method: "POST",
      })
      if (!res.ok) throw new Error("failed")
      window.location.reload()
    } catch {
      setBusy(null)
      alert(copy.disconnectFailed)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={copy.searchPlaceholder}
          aria-label={copy.searchPlaceholder}
          className="h-9 pl-8"
        />
      </div>

      <div className="bg-muted/60 w-fit rounded-lg p-0.5">
        <span className="bg-background text-foreground rounded-md px-2.5 py-1 text-xs font-medium shadow-sm">
          {copy.yourConnectors}
        </span>
      </div>

      {error ? (
        <p className="text-destructive text-sm">{error}</p>
      ) : (
        <div className="min-w-0">
          <div className="text-muted-foreground grid grid-cols-[minmax(0,1fr)_5.5rem_8.5rem] gap-3 border-b px-1 pb-2 text-xs">
            <span>{copy.connector}</span>
            <span className="hidden sm:block">{copy.type}</span>
            <span className="text-end">{copy.status}</span>
          </div>

          {accounts === null ? (
            <div className="divide-border/60 divide-y">
              {PROVIDERS.map((provider) => (
                <div
                  key={provider}
                  className="grid grid-cols-[minmax(0,1fr)_5.5rem_7.5rem] items-center gap-3 py-3"
                >
                  <div className="bg-muted h-5 w-28 animate-pulse rounded" />
                  <div className="bg-muted hidden h-5 w-12 animate-pulse rounded sm:block" />
                  <div className="bg-muted ml-auto h-7 w-16 animate-pulse rounded-lg" />
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            <p className="text-muted-foreground px-1 py-6 text-sm">{copy.noMatches}</p>
          ) : (
            <ul className="divide-border/60 divide-y">
              {visible.map((row) => (
                <ConnectorRow
                  key={row.provider}
                  row={row}
                  busy={busy === row.provider}
                  onConnect={() => void connect(row.provider)}
                  onDisconnect={() => {
                    if (row.account) void disconnect(row.account)
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function ConnectorRow({
  row,
  busy,
  onConnect,
  onDisconnect,
}: {
  row: Row
  busy: boolean
  onConnect: () => void
  onDisconnect: () => void
}) {
  const t = useTranslations()
  const copy = t.settings.connections
  const name = row.provider === "gmail" ? copy.gmail : copy.outlook
  const status = row.account?.status
  const connected = status === "active"
  const needsReconnect = status === "expired" || status === "revoked"

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_5.5rem_8.5rem] items-center gap-3 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <ProviderMark provider={row.provider} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          {row.account?.accountEmail ? (
            <p className="text-muted-foreground truncate text-xs">
              {row.account.accountEmail}
            </p>
          ) : null}
        </div>
      </div>
      <span className="text-muted-foreground hidden text-sm sm:block">
        {copy.typeEmail}
      </span>
      <div className="flex items-center justify-end">
        {connected ? (
          <div className="flex items-center justify-end gap-1">
            <CheckIcon
              className="text-muted-foreground size-4"
              aria-label={copy.connected}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={onDisconnect}
            >
              {busy ? copy.disconnecting : copy.disconnect}
            </Button>
          </div>
        ) : needsReconnect ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onConnect}
            className="gap-1.5"
          >
            <AlertTriangleIcon className="size-3.5 text-amber-500" />
            {busy ? copy.connecting : copy.reconnect}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={onConnect}>
            {busy ? copy.connecting : copy.connect}
          </Button>
        )}
      </div>
    </li>
  )
}

function ProviderMark({ provider }: { provider: Provider }) {
  return (
    <span
      aria-hidden
      className="border-border/60 bg-background flex size-6 shrink-0 items-center justify-center rounded-md border"
    >
      {provider === "gmail" ? <GmailMark /> : <OutlookMark />}
    </span>
  )
}

function GmailMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none">
      <path d="M2 6.5 12 13l10-6.5V18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6.5Z" fill="#EA4335" />
      <path d="M2 6.5 12 13 22 6.5 12 2 2 6.5Z" fill="#FBBC04" />
      <path d="M2 6.5V18l7-5.2L2 6.5Z" fill="#4285F4" />
      <path d="M22 6.5V18l-7-5.2 7-6.3Z" fill="#34A853" />
    </svg>
  )
}

function OutlookMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5">
      <rect x="3" y="3" width="8.4" height="8.4" fill="#F25022" />
      <rect x="12.6" y="3" width="8.4" height="8.4" fill="#7FBA00" />
      <rect x="3" y="12.6" width="8.4" height="8.4" fill="#00A4EF" />
      <rect x="12.6" y="12.6" width="8.4" height="8.4" fill="#FFB900" />
    </svg>
  )
}
