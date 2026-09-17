"use client";

import { useMemo } from "react";
import { useRig } from "@/lib/store";
import type { LeakLevel } from "@proto/types";

/** The parts of telemetry that change rarely and drive React re-renders (colours, lights, handles). */
export interface Discrete {
  online: boolean;
  hasTel: boolean;
  valves: [boolean, boolean];
  pump: boolean;
  /** Branch 2 has no meters, so its level is always 0 - see docs/PROTOCOL.md §0. */
  leak: [LeakLevel, LeakLevel];
}

const lv = (ch: string | undefined): LeakLevel => (Math.min(3, Math.max(0, Number(ch) || 0)) as LeakLevel);

function parse(key: string): Discrete {
  // key layout: [online][hasTel][v1v2][pump][l1l2]  (7 chars)
  return {
    online: key[0] === "1",
    hasTel: key[1] === "1",
    valves: [key[2] === "1", key[3] === "1"],
    pump: key[4] === "1",
    leak: [lv(key[5]), lv(key[6])],
  };
}

/** Selects a primitive key from the store so the component only re-renders when a discrete state flips. */
export function useDiscrete(): Discrete {
  const key = useRig((s) => {
    const t = s.tel;
    const on = s.online ? "1" : "0";
    if (!t) return `${on}000000`;
    return `${on}1${t.v.join("")}${t.pump}${t.leak.join("")}`;
  });
  return useMemo(() => parse(key), [key]);
}
