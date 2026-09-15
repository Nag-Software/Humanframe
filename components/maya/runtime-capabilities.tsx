"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * What the active runtime can actually do.
 *
 * assistant-ui renders reload, edit and branch controls unconditionally, and a
 * runtime that does not implement them throws when the button is pressed. The
 * eve runtime has no reload or branch semantics, so those affordances are not
 * offered rather than offered and broken.
 */
export type RuntimeCapabilities = {
  reload: boolean;
  edit: boolean;
  branching: boolean;
};

const FULL: RuntimeCapabilities = { reload: true, edit: true, branching: true };

const RuntimeCapabilitiesContext = createContext<RuntimeCapabilities>(FULL);

export function RuntimeCapabilitiesProvider({
  capabilities,
  children,
}: {
  capabilities: RuntimeCapabilities;
  children: ReactNode;
}) {
  return (
    <RuntimeCapabilitiesContext.Provider value={capabilities}>
      {children}
    </RuntimeCapabilitiesContext.Provider>
  );
}

export function useRuntimeCapabilities(): RuntimeCapabilities {
  return useContext(RuntimeCapabilitiesContext);
}
