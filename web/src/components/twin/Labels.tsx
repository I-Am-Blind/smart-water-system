"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import { Vector3 } from "three";
import type { Brand } from "@proto/types";
import { LABEL_ANCHORS, type LabelAlign, type Vec } from "./layout";
import { live, liveRate, liveValveOpen } from "./live";

export interface LabelEntry {
  key: string;
  anchor: Vec;
  align: LabelAlign;
  el: HTMLDivElement | null;
  valueEl: HTMLSpanElement | null;
  value: () => string;
}
export type LabelRegistry = LabelEntry[];

const f2 = (n: number) => n.toFixed(2);

/**
 * Branch 1 has both meters, so its chip prints in → out. Branch 2 has none, so it prints the
 * valve relay state and says so, rather than a number nothing measured. See docs/PROTOCOL.md §0.
 */
function branchValue(i: number): string {
  if (i === 0) return `${f2(liveRate(0))} → ${f2(liveRate(1))} L/min`;
  if (!live.tel || !live.online) return "no meter";
  return `valve ${liveValveOpen(2) ? "open" : "closed"}, no meter`;
}

/** One registry per Twin instance: DOM nodes are attached by LabelsDom, positions written by LabelProjector. */
export function createRegistry(): LabelRegistry {
  const A = LABEL_ANCHORS;
  const entries: LabelRegistry = [
    // Word-only chip, shown while the pump relay is on (see LabelProjector).
    { key: "pump", anchor: A.pump.pos, align: A.pump.align, el: null, valueEl: null, value: () => "" },
  ];
  A.branch.forEach((b, i) => {
    entries.push({
      key: `b${i + 1}`,
      anchor: b.pos,
      align: b.align,
      el: null,
      valueEl: null,
      value: () => branchValue(i),
    });
  });
  return entries;
}

/** Chips that are only shown in some states. */
export function chipVisible(key: string): boolean {
  if (key === "pump") return !!(live.tel && live.online && live.tel.pump === 1);
  return true;
}

function titleFor(key: string, brand: Brand): string {
  if (key === "pump") return "Pump";
  const b = Number(key.slice(1));
  return brand.branches[b - 1] ?? key;
}

/**
 * Plain DOM chips rendered outside the Canvas; positioned imperatively by LabelProjector.
 * shadcn-native: page font, `text-xs`, `--card` surface with a `--border` line and the page radius.
 */
export function LabelsDom({ registry, brand, compact }: { registry: LabelRegistry; brand: Brand; compact: boolean }) {
  const chip: React.CSSProperties = {
    font: "inherit",
    fontSize: compact ? 11 : 12,
    lineHeight: 1.3,
    color: "var(--muted-foreground)",
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: compact ? "1px 6px" : "2px 8px",
    visibility: "hidden",
  };
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {registry.map((e) => (
        <div
          key={e.key}
          ref={(el) => {
            e.el = el;
          }}
          className="absolute left-0 top-0 whitespace-nowrap text-left will-change-transform"
          style={chip}
        >
          <div>{titleFor(e.key, brand)}</div>
          <span
            ref={(el) => {
              e.valueEl = el;
            }}
            className="block empty:hidden"
            style={{ color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}
          />
        </div>
      ))}
    </div>
  );
}

interface Rect {
  left: number;
  top: number;
  w: number;
  h: number;
  vis: boolean;
}

const GAP = 4;
/** Pixels between the anchor and the chip edge. */
export const OFFSET = 6;

/** Top-left corner of a chip of size w x h placed on its side of the projected anchor (x, y). */
export function placeChip(align: LabelAlign, x: number, y: number, w: number, h: number, out: { left: number; top: number }): void {
  if (align === "above") {
    out.left = x - w / 2;
    out.top = y - h - OFFSET;
  } else if (align === "left") {
    out.left = x - w - OFFSET;
    out.top = y - h / 2;
  } else {
    out.left = x + OFFSET;
    out.top = y - h / 2;
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.w + GAP && b.left < a.left + a.w + GAP && a.top < b.top + b.h + GAP && b.top < a.top + a.h + GAP;
}

/**
 * Lives inside the Canvas: projects anchors to screen space ~20x per second, places each chip on its side
 * of the anchor, hides chips whose anchor is off-screen, pushes overlapping chips upward (the lowest one
 * keeps its place) and writes styles directly. No React re-renders.
 */
export function LabelProjector({ registry }: { registry: LabelRegistry }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const v = useMemo(() => new Vector3(), []);
  const acc = useMemo(() => ({ t: 1 }), []); // starts at 1 so the first frame fills the chips before the camera measures them
  const rects = useMemo<Rect[]>(() => registry.map(() => ({ left: 0, top: 0, w: 0, h: 0, vis: false })), [registry]);
  const order = useMemo(() => registry.map((_, i) => i), [registry]);

  useFrame((_, delta) => {
    acc.t += delta;
    if (acc.t < 1 / 20) return;
    acc.t = 0;

    for (let i = 0; i < registry.length; i++) {
      const e = registry[i];
      const r = rects[i];
      const el = e.el;
      if (!el) {
        r.vis = false;
        continue;
      }
      if (!chipVisible(e.key)) {
        r.vis = false;
        continue;
      }
      const val = e.value();
      if (e.valueEl && e.valueEl.textContent !== val) e.valueEl.textContent = val;
      v.set(e.anchor[0], e.anchor[1], e.anchor[2]).project(camera);
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      r.vis = v.z <= 1 && x >= 0 && x <= size.width && y >= 0 && y <= size.height;
      if (!r.vis) continue;
      r.w = el.offsetWidth;
      r.h = el.offsetHeight;
      placeChip(e.align, x, y, r.w, r.h, r);
    }

    // Resolve overlaps from the lowest chip on screen upward; a later chip moves above the one it hits.
    order.sort((a, b) => rects[b].top - rects[a].top);
    for (let k = 1; k < order.length; k++) {
      const r = rects[order[k]];
      if (!r.vis) continue;
      for (let pass = 0; pass < 2; pass++) {
        for (let j = 0; j < k; j++) {
          const o = rects[order[j]];
          if (o.vis && overlaps(r, o)) r.top = o.top - r.h - GAP;
        }
      }
    }

    for (let i = 0; i < registry.length; i++) {
      const el = registry[i].el;
      const r = rects[i];
      if (!el) continue;
      el.style.visibility = r.vis ? "visible" : "hidden";
      if (r.vis) el.style.transform = `translate(${r.left.toFixed(1)}px, ${r.top.toFixed(1)}px)`;
    }
  });
  return null;
}
