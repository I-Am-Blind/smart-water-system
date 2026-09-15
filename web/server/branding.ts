/**
 * Loads branding.json from the repository root, validates it, watches it for edits,
 * and computes this server's LAN URL (used for the QR code and mobile defaults).
 */
import { readFileSync, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrandSchema } from "@proto/schema";
import type { Brand } from "@proto/types";
import { log, logError } from "./log";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const BRANDING_PATH = path.join(REPO_ROOT, "branding.json");

export function loadBrand(file: string = BRANDING_PATH): Brand {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  const p = BrandSchema.parse(raw);
  return {
    name: p.name,
    shortName: p.shortName,
    tagline: p.tagline,
    deviceName: p.deviceName,
    team: p.team,
    school: p.school,
    branches: p.branches,
    colors: p.colors,
    showQr: p.showQr,
  };
}

/**
 * Watches the directory containing branding.json (editors often replace the file, which
 * breaks a direct file watch) and calls onChange with a freshly validated Brand.
 * Invalid edits are logged and ignored; the previous brand stays in effect.
 */
export function watchBranding(onChange: (brand: Brand) => void): FSWatcher | null {
  let timer: NodeJS.Timeout | null = null;
  try {
    const watcher = watch(path.dirname(BRANDING_PATH), (_event, filename) => {
      if (filename && filename !== path.basename(BRANDING_PATH)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          onChange(loadBrand());
          log("BRAND", "branding.json reloaded");
        } catch (err) {
          logError("BRAND", "branding.json is invalid, keeping previous values", err);
        }
      }, 300);
    });
    watcher.on("error", (err) => logError("BRAND", "watcher error", err));
    return watcher;
  } catch (err) {
    logError("BRAND", "could not watch branding.json", err);
    return null;
  }
}

/** First non-internal IPv4 address of this machine, or localhost. */
export function lanAddress(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "localhost";
}

export function computeServerUrl(port: number): string {
  const host = process.env.RENDER_EXTERNAL_URL; // set automatically on Render
  if (host) return host.replace(/\/$/, "");
  return `http://${lanAddress()}:${port}`;
}
