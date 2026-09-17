"use client";

import { useEffect } from "react";
import { getState, subscribe } from "@/lib/store";
import type { Telemetry } from "@proto/types";
import type { RateSource } from "./layout";

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

/** Flow (L/min) for sensor index 0 (branch 1 IN) or 1 (OUT); 0 while offline so the twin visibly freezes. */
export function liveRate(idx: number): number {
  const t = live.tel;
  if (!t || !live.online) return 0;
  return t.f[idx] ?? 0;
}

/** Valve state of branch b (1-based), as reported by the rig. */
export function liveValveOpen(b: number): boolean {
  const t = live.tel;
  return !!t && live.online && t.v[b - 1] === 1;
}

/**
 * Branch 2 has no meter, so there is no rate to show. Water is drawn moving at a fixed nominal
 * speed whenever the pump is running and that valve is open - which are both measured facts - and
 * no number is ever printed for it. See the "no meter" chip in Labels.tsx.
 */
export const UNMETERED_LPM = 1.0;

export function liveUnmeteredRate(): number {
  const t = live.tel;
  if (!t || !live.online) return 0;
  return t.pump === 1 && liveValveOpen(2) ? UNMETERED_LPM : 0;
}

/** The shared line from the tank: everything the branches draw. */
export function liveMainRate(): number {
  return liveRate(0) + liveUnmeteredRate();
}

/** The shared line back to the tank: everything the branches return. */
export function liveReturnRate(): number {
  return liveRate(1) + liveUnmeteredRate();
}

/** L/min for any pipe in the twin. The one place that maps a RateSource to a number. */
export function rateOf(sensor: RateSource): number {
  if (sensor === "main") return liveMainRate();
  if (sensor === "ret") return liveReturnRate();
  if (sensor === "unmetered") return liveUnmeteredRate();
  return liveRate(sensor);
}

/** true when the OS asks for reduced motion: particles freeze, spray becomes a static marker. */
export function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
