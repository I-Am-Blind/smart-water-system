"use client";

import { createContext, useContext, useMemo } from "react";
import { Color } from "three";
import type { Brand } from "@proto/types";

/** shadcn tokens the twin follows, resolved to `#rrggbb` at mount (see readCssTokens). */
export interface CssTokens {
  background: string;
  card: string;
  border: string;
  foreground: string;
  mutedForeground: string;
  destructive: string;
  chart3: string;
}

/** Used only if a variable is missing or unparsable (shadcn neutral, dark). */
export const FALLBACK_TOKENS: CssTokens = {
  background: "#0a0a0a",
  card: "#171717",
  border: "#262626",
  foreground: "#fafafa",
  mutedForeground: "#a1a1a1",
  destructive: "#ef4444",
  chart3: "#f59e0b",
};

let scratch: CanvasRenderingContext2D | null | undefined;

/** Resolves any CSS colour the browser understands (hex, rgb, oklch, ...) to `#rrggbb` via a 1x1 canvas. */
export function parseCssColor(value: string, fallback: string): string {
  const v = value.trim();
  if (!v || typeof document === "undefined") return fallback;
  if (scratch === undefined) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    scratch = c.getContext("2d", { willReadFrequently: true });
  }
  const g = scratch;
  if (!g) return fallback;
  g.fillStyle = "#010203"; // sentinel: an invalid `value` leaves it untouched
  g.fillStyle = v;
  if (g.fillStyle === "#010203" && !/^#010203$/i.test(v)) return fallback;
  g.clearRect(0, 0, 1, 1);
  g.fillRect(0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return `#${[d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Reads the shadcn variables that apply to `el` (custom properties inherit, so the twin's wrapper is enough). */
export function readCssTokens(el: Element): CssTokens {
  const cs = getComputedStyle(el);
  const get = (name: string, fb: string) => parseCssColor(cs.getPropertyValue(name), fb);
  return {
    background: get("--background", FALLBACK_TOKENS.background),
    card: get("--card", FALLBACK_TOKENS.card),
    border: get("--border", FALLBACK_TOKENS.border),
    foreground: get("--foreground", FALLBACK_TOKENS.foreground),
    mutedForeground: get("--muted-foreground", FALLBACK_TOKENS.mutedForeground),
    destructive: get("--destructive", FALLBACK_TOKENS.destructive),
    chart3: get("--chart-3", FALLBACK_TOKENS.chart3),
  };
}

export interface Theme {
  bg: Color;
  ground: Color;
  slab: Color;
  grid: Color;
  /** Water (brand accent): tubes, particles, running pump ring. */
  accent: Color;
  water: Color;
  particle: Color;
  /** Leak (`--destructive`). */
  danger: Color;
  /** Warning (`--chart-3`, amber). */
  warn: Color;
  /** Neutral steel tones for everything that is not water or a fault. */
  pipe: Color;
  metal: Color;
  dark: Color;
  closed: Color;
  glass: Color;
}

/** The three colours the twin may take from the brand or a caller-supplied palette. */
export interface Accents {
  accent: string;
  warn: string;
  danger: string;
}

export function makeTheme(a: Accents, t: CssTokens): Theme {
  const bg = new Color(t.background);
  const accent = new Color(a.accent);
  return {
    bg,
    ground: bg.clone(),
    slab: new Color(t.card),
    grid: new Color(t.mutedForeground),
    accent,
    water: accent.clone(),
    particle: accent.clone().lerp(new Color("#ffffff"), 0.4),
    danger: new Color(a.danger),
    warn: new Color(a.warn),
    pipe: new Color("#7c8797"),
    metal: new Color("#a3adba"),
    dark: new Color("#3a4250"),
    closed: new Color("#5b6472"),
    glass: new Color("#b8c2cf"),
  };
}

/**
 * Accent colours: a `palette` prop wins; otherwise water is the brand accent and warn / leak
 * follow the page theme (`--chart-3`, `--destructive`).
 */
export function resolveAccents(brand: Brand, tokens: CssTokens, palette?: Brand["colors"]): Accents {
  return palette
    ? { accent: palette.accent, warn: palette.warn, danger: palette.danger }
    : { accent: brand.colors.accent, warn: tokens.chart3, danger: tokens.destructive };
}

export function useTheme(a: Accents, t: CssTokens): Theme {
  return useMemo(
    () => makeTheme(a, t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [a.accent, a.warn, a.danger, t.background, t.card, t.mutedForeground],
  );
}

export interface TwinCtx {
  theme: Theme;
  brand: Brand;
}

export const TwinContext = createContext<TwinCtx | null>(null);

export function useTwin(): TwinCtx {
  const v = useContext(TwinContext);
  if (!v) throw new Error("useTwin must be used inside <TwinContext.Provider>");
  return v;
}
