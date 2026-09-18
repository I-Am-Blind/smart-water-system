/** Small shared helpers for copy and formatting on the dashboard. */

/** "2 s ago", "3 min ago", "1 h ago". */
export function agoShort(at: number | null, now: number = Date.now()): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** 14:02 */
export function fmtHm(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** 14:02:09 */
export function fmtHms(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmt2(v: number | undefined | null): string {
  return v === undefined || v === null || !Number.isFinite(v) ? "--" : v.toFixed(2);
}

export function describeAckError(err: string, act?: string, branchName?: string): string {
  const target = act === "valve" && branchName ? branchName : act === "pump" ? "the pump" : "the rig";
  switch (err) {
    case "latched": return `Couldn't open ${branchName ?? "the valve"}: the leak is still latched. Clear the leak first.`;
    case "auto_mode": return "The rig is in Automatic mode. Switch to Manual to control the valves.";
    case "no_open_valve": return "Couldn't start the pump: open at least one valve first.";
    case "bad_branch": return "That branch doesn't exist on the rig.";
    case "unknown_act":
    case "bad_json":
    case "bad_cmd": return "The rig didn't understand that command.";
    case "device_offline": return `The rig is offline, so the command for ${target} wasn't sent.`;
    case "timeout": return `The rig didn't answer in time for ${target}. Try again.`;
    case "server connection lost": return "Lost the connection to the server. Reconnecting.";
    default: return `Command failed: ${err}.`;
  }
}
