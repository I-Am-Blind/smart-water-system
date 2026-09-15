"use client";

import { useMemo } from "react";
import { useRig } from "@/lib/store";
import type { LeakLevel } from "@proto/types";

/** The parts of telemetry that change rarely and drive React re-renders (colours, lights, handles). */
export interface Discrete {
  online: boolean;
  hasTel: boolean;
  valves: [boolean, boolean, boolean];
  pump: boolean;
  leak: [LeakLevel, LeakLevel, LeakLevel];
  mleak: boolean;
}

const lv = (ch: string | undefined): LeakLevel => (Math.min(3, Math.max(0, Number(ch) || 0)) as LeakLevel);

function parse(key: string): Discrete {
  // key layout: [online][hasTel][v1v2v3][pump][l1l2l3][mleak]  (10 chars)
  return {
    online: key[0] === "1",
    hasTel: key[1] === "1",
    valves: [key[2] === "1", key[3] === "1", key[4] === "1"],
    pump: key[5] === "1",
    leak: [lv(key[6]), lv(key[7]), lv(key[8])],
    mleak: key[9] === "1",
  };
}

/** Selects a primitive key from the store so the component only re-renders when a discrete state flips. */
export function useDiscrete(): Discrete {
  const key = useRig((s) => {
    const t = s.tel;
    const on = s.online ? "1" : "0";
    if (!t) return `${on}0000000000`;
    return `${on}1${t.v.join("")}${t.pump}${t.leak.join("")}${t.mleak}`;
  });
  return useMemo(() => parse(key), [key]);
}
