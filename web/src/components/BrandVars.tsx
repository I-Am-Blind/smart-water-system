"use client";
import { useEffect } from "react";
import { useRig } from "@/lib/store";

/** Keeps --brand-accent (water in the twin, the inflow line in the chart) in sync with branding.json as served live. */
export function BrandVars() {
  const accent = useRig((s) => s.brand.colors.accent);
  useEffect(() => {
    document.documentElement.style.setProperty("--brand-accent", accent);
  }, [accent]);
  return null;
}
