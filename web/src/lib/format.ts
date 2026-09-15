/** Formatting helpers shared by the dashboard components. */

export function fmtLpm(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "--";
  return v.toFixed(2);
}

export function fmtPct(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "--";
  return `${v.toFixed(1)}%`;
}

export function ago(at: number | null, now: number = Date.now()): string {
  if (!at) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtUptime(sec: number | undefined): string {
  if (sec === undefined) return "--";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

export function fmtClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** 0..4 bars from RSSI in dBm. */
export function rssiBars(rssi: number | undefined): number {
  if (rssi === undefined) return 0;
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  if (rssi >= -85) return 1;
  return 0;
}

export type Tone = "ok" | "warn" | "danger" | "muted";

/** Plain-English turbidity band (NTU). */
export function turbidityBand(ntu: number): { label: string; tone: Tone } {
  if (ntu < 1) return { label: "Excellent", tone: "ok" };
  if (ntu < 5) return { label: "Good", tone: "ok" };
  if (ntu < 25) return { label: "Cloudy", tone: "warn" };
  return { label: "Poor", tone: "danger" };
}

/** WHO palatability bands for TDS (ppm). */
export function tdsBand(ppm: number): { label: string; tone: Tone } {
  if (ppm < 300) return { label: "Excellent", tone: "ok" };
  if (ppm < 600) return { label: "Good", tone: "ok" };
  if (ppm < 900) return { label: "Fair", tone: "warn" };
  if (ppm < 1200) return { label: "Poor", tone: "warn" };
  return { label: "Unacceptable", tone: "danger" };
}
