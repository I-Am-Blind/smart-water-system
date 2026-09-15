import type { Brand, CmdBody, LeakLevel, RigEvent } from "../../packages/protocol/types";

export type Tone = "ok" | "warn" | "danger" | "accent" | "muted";

export const fmtLpm = (n: number): string => n.toFixed(2);
export const fmtPct = (n: number): string => `${n.toFixed(1)}%`;

export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "14:02" for banners. */
export function since(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Sentence-case status label for a branch badge. */
export const LEAK_BADGE: Record<LeakLevel, string> = { 0: "", 1: "Warning", 2: "Leak", 3: "Leak" };

export function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function leakTone(level: LeakLevel): Tone {
  if (level === 0) return "ok";
  if (level === 1) return "warn";
  return "danger";
}

const SRC: Record<string, string> = {
  serial: "serial console",
  ws: "app",
  http: "local HTTP",
  leak: "leak logic",
  wd: "watchdog",
  interlock: "interlock",
  boot: "boot",
};

export function describeEvent(e: RigEvent, branches: Brand["branches"]): string {
  const name = e.b ? branches[e.b - 1] : "";
  const src = SRC[e.src] ?? e.src;
  switch (e.ev) {
    case "leak":
      return `${name}: ${e.kind ?? "leak"} leak, ${e.loss?.toFixed(1) ?? "?"}% loss. Valve closed.`;
    case "leak_clear":
      return `Leak latches reset (${src}).`;
    case "mleak":
      return `Manifold leak, ${e.loss?.toFixed(1) ?? "?"}% loss. Pump stopped.`;
    case "valve":
      return `${name} valve ${e.on ? "opened" : "closed"} (${src}${e.reason ? `, ${e.reason.replace("_", " ")}` : ""}).`;
    case "pump":
      return `Pump ${e.on ? "started" : "stopped"} (${src}${e.reason ? `, ${e.reason.replace("_", " ")}` : ""}).`;
    case "all_off":
      return `All relays off (${src}).`;
    case "boot":
      return "Device booted.";
    case "sim":
      return `Simulation ${e.on ? "on" : "off"} (${src}).`;
    default:
      return `${e.ev}`;
  }
}

export function eventTone(e: RigEvent): Tone {
  switch (e.ev) {
    case "leak":
    case "mleak":
      return "danger";
    case "all_off":
    case "leak_clear":
      return "warn";
    case "valve":
    case "pump":
      return "accent";
    default:
      return "muted";
  }
}

/** Plain-words explanation of a failed command, e.g. "Couldn't open Branch 2: the leak is still latched. Clear the leak first." */
export function describeError(err: string, cmd: CmdBody | undefined, branches: Brand["branches"]): string {
  const what = (() => {
    if (!cmd) return "Couldn't send the command";
    const name = cmd.b ? branches[cmd.b - 1] : "the branch";
    switch (cmd.act) {
      case "valve": return `Couldn't ${cmd.on ? "open" : "close"} ${name}`;
      case "pump": return cmd.on ? "Couldn't start the pump" : "Couldn't stop the pump";
      case "all_off": return "Couldn't switch everything off";
      case "reset_leak": return "Couldn't clear the leak";
      default: return "Couldn't send the command";
    }
  })();
  const why: Record<string, string> = {
    latched: "the leak is still latched. Clear the leak first.",
    bad_branch: "the rig does not know that branch.",
    no_open_valve: "open a valve before starting the pump.",
    unknown_act: "the rig does not know this command.",
    bad_json: "the rig rejected the message.",
    device_offline: "the rig is offline.",
    timeout: "the rig did not answer in time.",
    bad_cmd: "the server rejected it.",
    not_connected: "not connected to the server.",
  };
  return `${what}: ${why[err] ?? "it failed."}`;
}
