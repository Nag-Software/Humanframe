"use client";

import dynamic from "next/dynamic";

import { useMediaQuery } from "@/hooks/use-media-query";

// Motion only ships to viewports that actually render the panel.
const AuthVisual = dynamic(() => import("@/components/auth/auth-visual"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[#08080a]" />,
});

export function AuthVisualPanel() {
  const isLargeScreen = useMediaQuery("(min-width: 1024px)");

  if (!isLargeScreen) {
    return null;
  }

  return <AuthVisual />;
}
