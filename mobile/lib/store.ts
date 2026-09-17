/**
 * Tiny external store for the rig state. Same RigState shape and useRig() signature as
 * web/src/lib/store.ts (see docs/PROTOCOL.md section 8) so the two UIs stay interchangeable.
 * No state library: a module-level object + useSyncExternalStore.
 */
import { useSyncExternalStore } from "react";
import type {
  Brand, Hello, RigEvent, ServerToViewer, Stamped, Telemetry, ViewerCmd,
} from "../../packages/protocol/types";
import { ACK_TIMEOUT_MS } from "../../packages/protocol/types";
import brandingJson from "../../branding.json";

export type Conn = "connecting" | "open" | "closed";

export interface RigState {
  /** This app's socket to the server. */
  conn: Conn;
  /** Device online, as reported by the server. */
  online: boolean;
  lastSeen: number | null;
  info: Hello | null;
  tel: Stamped<Telemetry> | null;
  /** Newest first, at most 50. */
  events: Stamped<RigEvent>[];
  brand: Brand;
  serverUrl: string;
  /** Commands awaiting an ack, keyed by cid. */
  pending: Record<string, ViewerCmd>;
  /** Most recent failed command, for a transient banner. */
  lastError: { cid: string; err: string; at: number; cmd?: ViewerCmd } | null;
}

/** branding.json is the pre-connect default; the server's `state`/`brand` messages override it. */
export const DEFAULT_BRAND: Brand = {
  name: brandingJson.name,
  shortName: brandingJson.shortName,
  tagline: brandingJson.tagline,
  deviceName: brandingJson.deviceName,
  team: brandingJson.team,
  school: brandingJson.school,
  branches: [brandingJson.branches[0], brandingJson.branches[1]],
  colors: brandingJson.colors,
  showQr: brandingJson.showQr,
};

let state: RigState = {
  conn: "closed",
  online: false,
  lastSeen: null,
  info: null,
  tel: null,
  events: [],
  brand: DEFAULT_BRAND,
  serverUrl: "",
  pending: {},
  lastError: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<RigState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getState(): RigState {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Selector hook. Selectors must return stable slices or primitives to avoid needless re-renders. */
export function useRig<T>(sel: (s: RigState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state), () => sel(state));
}

export function setConn(conn: Conn): void {
  if (state.conn !== conn) set({ conn });
}

export function clearPending(): void {
  if (Object.keys(state.pending).length > 0) set({ pending: {} });
}

export function clearError(): void {
  if (state.lastError) set({ lastError: null });
}

function dropPending(cid: string): Record<string, ViewerCmd> {
  const rest = { ...state.pending };
  delete rest[cid];
  return rest;
}

/** Apply one server -> viewer message. Unknown `t` values are ignored (forward compatible). */
export function applyMessage(msg: ServerToViewer): void {
  switch (msg.t) {
    case "state":
      set({
        online: msg.online,
        lastSeen: msg.lastSeen,
        info: msg.info,
        tel: msg.tel,
        events: msg.events,
        brand: msg.brand,
        serverUrl: msg.serverUrl,
      });
      break;
    case "tel":
      set({ tel: msg, online: true, lastSeen: msg.at });
      break;
    case "evt":
      set({ events: [msg, ...state.events].slice(0, 50) });
      break;
    case "device":
      set({ online: msg.online, lastSeen: msg.lastSeen, info: msg.info });
      break;
    case "ack":
      set({
        pending: dropPending(msg.cid),
        lastError: msg.ok ? state.lastError : { cid: msg.cid, err: msg.err ?? "failed", at: Date.now(), cmd: state.pending[msg.cid] },
      });
      break;
    case "brand":
      set({ brand: msg.brand });
      break;
    case "err":
      console.warn("[server]", msg.msg);
      break;
    default:
      break;
  }
}

// ---- commands ----
// The socket module registers itself here so this file has no import cycle with it.
let transport: ((json: string) => boolean) | null = null;
export function registerTransport(fn: (json: string) => boolean): void {
  transport = fn;
}

let seq = 0;

/** Send a command to the device via the server. Returns the cid; the ack arrives as a message. */
export function sendCmd(cmd: Omit<ViewerCmd, "t" | "cid">): string {
  const cid = `m-${Date.now()}-${++seq}`;
  const full: ViewerCmd = { t: "cmd", cid, ...cmd };
  if (!transport || !transport(JSON.stringify(full))) {
    set({ lastError: { cid, err: "not_connected", at: Date.now(), cmd: full } });
    return cid;
  }
  set({ pending: { ...state.pending, [cid]: full } });
  // The server answers within ACK_TIMEOUT_MS (with err "timeout" at worst); this is a safety net.
  setTimeout(() => {
    if (state.pending[cid]) {
      set({ pending: dropPending(cid), lastError: { cid, err: "timeout", at: Date.now(), cmd: full } });
    }
  }, ACK_TIMEOUT_MS + 2000);
  return cid;
}
