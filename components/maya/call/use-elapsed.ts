"use client";

import { useEffect, useRef, useState } from "react";

import type { CallStatus } from "@/components/maya/call/use-call";

/**
 * Time together, in milliseconds, counted from the moment the call connected.
 * Not a countdown and not a budget — the server enforces the ceiling.
 */
export function useElapsed(status: CallStatus): number {
  const connectedAt = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status !== "connected") {
      return;
    }
    const startedAt = (connectedAt.current ??= Date.now());
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [status]);

  return elapsed;
}
