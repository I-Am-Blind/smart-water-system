/**
 * Browser-side rig state. A plain module store with a React selector hook; no state library.
 * The API is fixed by docs/PROTOCOL.md §8 — the dashboard and the 3D twin both depend on it.
 */
import { useSyncExternalStore } from "react";
import type { Brand, Hello, RigEvent, ServerToViewer, Stamped, Telemetry, ViewerCmd } from "@proto/types";
import brandingJson from "../../../branding.json";

export interface RigState {
  /** This browser's socket to the server. */
  conn: "connecting" | "open" | "closed";
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
  /** Last command/socket error (ack err code or socket message); cleared by the next successful ack. */
  lastError: string | null;
}

const DEFAULT_BRAND: Brand = {
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

/** Frozen initial state; also the server-render snapshot so hydration is stable. */
export const EMPTY_STATE: RigState = Object.freeze({
  conn: "connecting",
  online: false,
  lastSeen: null,
  info: null,
  tel: null,
  events: [],
  brand: DEFAULT_BRAND,
  serverUrl: "",
  pending: {},
  lastError: null,
}) as RigState;

let state: RigState = EMPTY_STATE;
const listeners = new Set<() => void>();
let sender: ((text: string) => boolean) | null = null;
let cidSeq = 0;
const PENDING_TTL_MS = 5000;

function emit(): void {
  for (const l of listeners) l();
}

export function getState(): RigState {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Replace part of the state. Only pass slices that actually changed (keeps selectors stable). */
export function setState(partial: Partial<RigState>): void {
  state = { ...state, ...partial };
  emit();
}

/**
 * React hook: subscribe to a slice. The selector must return a primitive or a slice whose
 * reference only changes when its content changes (e.g. `s.tel`, `s.events`, `s.online`).
 */
export function useRig<T>(sel: (s: RigState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state), () => sel(EMPTY_STATE));
}

/** Wire-up point for the ws client. Not part of the public API. */
export function _setSender(fn: ((text: string) => boolean) | null): void {
  sender = fn;
}

/** Sends a command to the device via the server. Returns the cid; the ack clears `pending[cid]`. */
export function sendCmd(cmd: Omit<ViewerCmd, "t" | "cid">): string {
  const cid = `v-${Date.now()}-${++cidSeq}`;
  const full: ViewerCmd = { t: "cmd", cid, ...cmd };
  const sent = sender ? sender(JSON.stringify(full)) : false;
  if (sent) {
    setState({ pending: { ...state.pending, [cid]: full } });
    setTimeout(() => clearPending(cid), PENDING_TTL_MS);
  }
  return cid;
}

export function clearPending(cid: string): void {
  if (!(cid in state.pending)) return;
  const pending = { ...state.pending };
  delete pending[cid];
  setState({ pending });
}

/** Applies one server message. Used by the ws client; exported for tests. */
export function applyMessage(msg: ServerToViewer): void {
  switch (msg.t) {
    case "state":
      setState({
        online: msg.online, lastSeen: msg.lastSeen, info: msg.info, tel: msg.tel,
        events: msg.events, brand: msg.brand, serverUrl: msg.serverUrl,
      });
      break;
    case "tel":
      setState({ tel: msg, lastSeen: msg.at, online: true });
      break;
    case "evt":
      setState({ events: [msg, ...state.events].slice(0, 50), lastSeen: msg.at });
      break;
    case "device":
      setState({ online: msg.online, lastSeen: msg.lastSeen, info: msg.info });
      break;
    case "ack":
      clearPending(msg.cid);
      setState({ lastError: msg.ok ? null : (msg.err ?? "error") });
      break;
    case "brand":
      setState({ brand: msg.brand });
      break;
    case "err":
      console.warn("[server]", msg.msg);
      break;
  }
}
