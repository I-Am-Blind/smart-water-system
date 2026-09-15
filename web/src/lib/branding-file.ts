/**
 * Server-component helper: reads branding.json from disk so the very first HTML render
 * (title, colours) matches the live values without waiting for the WebSocket.
 * Walks up from the working directory so it works from web/ or the repository root.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Brand } from "@proto/types";
import fallback from "../../../branding.json";

function findBrandingPath(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, "branding.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function readBrandFromDisk(): Brand {
  const file = findBrandingPath();
  const raw = file ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Brand>) : {};
  const b = { ...fallback, ...raw } as Brand & { $schema?: string };
  return {
    name: b.name, shortName: b.shortName, tagline: b.tagline, deviceName: b.deviceName,
    team: b.team ?? "", school: b.school ?? "",
    branches: [b.branches[0], b.branches[1], b.branches[2]],
    colors: b.colors, showQr: b.showQr,
  };
}

export function brandCssVars(b: Brand): Record<string, string> {
  return {
    "--brand-bg": b.colors.bg,
    "--brand-accent": b.colors.accent,
    "--brand-ok": b.colors.ok,
    "--brand-warn": b.colors.warn,
    "--brand-danger": b.colors.danger,
  };
}
