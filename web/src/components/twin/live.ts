"use client";

import { useEffect } from "react";
import { getState, subscribe } from "@/lib/store";
import type { Telemetry } from "@proto/types";

/**
 * Latest telemetry as a plain mutable object so useFrame animations can read it
 * every frame without any React re-render. Kept in sync by useLiveSync().
 */
export const live: { tel: Telemetry | null; online: boolean } = { tel: null, online: false };

export function useLiveSync(): void {
  useEffect(() => {
    const sync = () => {
      const s = getState();
      live.tel = s.tel;
      live.online = s.online;
    };
    sync();
    return subscribe(sync);
  }, []);
}

/** Flow (L/min) for sensor index 0..6; 0 while the rig is offline so the twin visibly freezes. */
export function liveRate(idx: number): number {
  const t = live.tel;
  if (!t || !live.online) return 0;
  return t.f[idx] ?? 0;
}

/** Sum of the three branch outflows (what the return line carries). */
export function liveReturnRate(): number {
  return liveRate(2) + liveRate(4) + liveRate(6);
}

/** true when the OS asks for reduced motion: particles freeze, spray becomes a static marker. */
export function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
