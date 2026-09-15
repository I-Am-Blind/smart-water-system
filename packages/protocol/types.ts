/**
 * Wire contract v1 for the leak-detection rig. Pure TypeScript: no runtime deps,
 * safe to import from the Next.js client bundle and from the Expo app.
 * The human-readable version is docs/PROTOCOL.md; zod validators are in ./schema.ts.
 *
 * Conventions
 *  - Every message has a `t` discriminator. Unknown `t` must be ignored.
 *  - Sensor arrays `f` / `p` are ordered [m, b1i, b1o, b2i, b2o, b3i, b3o].
 *  - Branch arrays (`loss`, `leak`, `v`) are index 0..2 = branch 1..3.
 *  - A scalar branch field `b` is 1..3.
 */

export const PROTO_VERSION = 1 as const;
export const WS_PATH = "/ws";
export const VIEWER_QUERY = "?role=viewer";
export const DEFAULT_WS_URL = "ws://192.168.0.3:3000/ws";

/** YF-S401: pulse frequency (Hz) = 98 x flow (L/min). */
export const HZ_PER_LPM = 98;
/** Device is "online" when its socket is open and a `tel` arrived within this window. */
export const ONLINE_TIMEOUT_MS = 5000;
/** Device must ack a cmd within this window; the server otherwise reports `timeout`. */
export const ACK_TIMEOUT_MS = 3000;
/** Duration the UI requests when turning the pump on (firmware caps at PUMP_MAX_ON_S). */
export const PUMP_UI_DUR_S = 120;
export const PUMP_MAX_ON_S = 300;
export const VALVE_MAX_ON_S = 600;

export const SENSOR_KEYS = ["m", "b1i", "b1o", "b2i", "b2o", "b3i", "b3o"] as const;
export type SensorKey = (typeof SENSOR_KEYS)[number];
export const SENSOR_INDEX: Record<SensorKey, number> = { m: 0, b1i: 1, b1o: 2, b2i: 3, b2o: 4, b3i: 5, b3o: 6 };

export const BRANCHES = [1, 2, 3] as const;
export type Branch = (typeof BRANCHES)[number];
export type OnOff = 0 | 1;
/** 0 ok, 1 warn (loss above warn threshold, no action), 2 drip (latched, valve closed), 3 burst (latched, valve closed). */
export type LeakLevel = 0 | 1 | 2 | 3;
export const LEAK_LABEL: Record<LeakLevel, string> = { 0: "OK", 1: "WARN", 2: "DRIP", 3: "BURST" };

// ---------- branding.json ----------
export interface Brand {
  name: string;
  shortName: string;
  tagline: string;
  deviceName: string;
  team: string;
  school: string;
  branches: [string, string, string];
  colors: { bg: string; accent: string; ok: string; warn: string; danger: string };
  showQr: boolean;
}

// ---------- device -> server ----------
export interface Hello {
  t: "hello";
  proto: typeof PROTO_VERSION;
  /** "rig-" + last 6 hex digits of the MAC, or "sim" for the fake device. */
  id: string;
  fw: string;
  ip: string;
  rssi: number;
  /** Reset reason as text: POWERON, SW, PANIC, INT_WDT, TASK_WDT, WDT, DEEPSLEEP, BROWNOUT, SDIO, UNKNOWN. */
  rst: string;
  sim: boolean;
}

export interface Telemetry {
  t: "tel";
  /** Device millis() at sample time (wraps at 2^32; use server `at` for time axes). */
  ms: number;
  seq: number;
  /** L/min per sensor, 2 dp, order SENSOR_KEYS. */
  f: number[];
  /** Raw cumulative pulse counts per sensor (uncalibrated), order SENSOR_KEYS. */
  p: number[];
  /** Per-branch loss % = (in - out) / in * 100 over the 3 s window; 0 when the check is gated off. */
  loss: number[];
  leak: LeakLevel[];
  /** Manifold leak latched (master flow exceeds sum of open branch inflows). */
  mleak: OnOff;
  /** Valve relay states, 1 = valve open (relay energised). */
  v: OnOff[];
  pump: OnOff;
  /** Turbidity: millivolts at the ADC pin and an NTU estimate (0..3000). */
  turb: { mv: number; ntu: number };
  /** TDS: millivolts at the ADC pin and ppm (25 C assumed). */
  tds: { mv: number; ppm: number };
  rssi: number;
  /** Uptime in seconds. */
  up: number;
  /** Free heap in bytes. */
  heap: number;
  sim: boolean;
}

export type EventKind = "boot" | "leak" | "leak_clear" | "mleak" | "valve" | "pump" | "all_off" | "sim";
export type EventSource = "serial" | "ws" | "http" | "leak" | "wd" | "interlock" | "boot";
export type EventReason = "max_on" | "all_closed" | "manifold";
export type LeakKind = "drip" | "burst";

export interface RigEvent {
  t: "evt";
  ms: number;
  ev: EventKind;
  b?: Branch;
  kind?: LeakKind;
  /** Loss % at the moment of the event (leak / mleak). */
  loss?: number;
  /** New state for valve / pump / sim events. */
  on?: OnOff;
  src: EventSource;
  reason?: EventReason;
}

export type DeviceAckError = "latched" | "bad_branch" | "no_open_valve" | "unknown_act" | "bad_json";

export interface DeviceAck {
  t: "ack";
  id: number;
  ok: boolean;
  err?: DeviceAckError;
  /** Device millis(), included in the reply to `ping`. */
  ms?: number;
}

// ---------- commands ----------
export type CmdAct = "valve" | "pump" | "all_off" | "reset_leak" | "ping" | "sim";

export interface CmdBody {
  act: CmdAct;
  /** Required for valve; for sim = branch to inject a leak into. */
  b?: Branch;
  /** valve / pump / sim: desired state. */
  on?: boolean;
  /** Seconds the relay may stay on (valve <= 600, pump <= 300; 0/absent = firmware default). */
  dur?: number;
  /** sim: injected loss percent for branch `b`. */
  pct?: number;
}

/** server -> device */
export interface DeviceCmd extends CmdBody {
  t: "cmd";
  id: number;
}

/** server -> device, sent once after hello; the device ignores it. */
export interface Welcome {
  t: "welcome";
  now: number;
}

/** viewer -> server. The server assigns the integer `id` and maps the ack back by `cid`. */
export interface ViewerCmd extends CmdBody {
  t: "cmd";
  cid: string;
}

export type ServerAckError = DeviceAckError | "device_offline" | "timeout" | "bad_cmd";

/** server -> viewer */
export interface ViewerAck {
  t: "ack";
  cid: string;
  ok: boolean;
  err?: ServerAckError;
  ms?: number;
}

// ---------- server -> viewer ----------
/** Server-stamped copy of a device message: `at` is the server's epoch ms on receipt. */
export type Stamped<T> = T & { at: number };

export interface StateMsg {
  t: "state";
  now: number;
  online: boolean;
  lastSeen: number | null;
  info: Hello | null;
  tel: Stamped<Telemetry> | null;
  /** Newest first, at most 50. */
  events: Stamped<RigEvent>[];
  brand: Brand;
  /** http://<lan-ip>:<port> of this server, for the QR code and mobile settings. */
  serverUrl: string;
}

export interface DeviceMsg {
  t: "device";
  online: boolean;
  lastSeen: number | null;
  info: Hello | null;
}

export interface BrandMsg {
  t: "brand";
  brand: Brand;
}

export interface ErrMsg {
  t: "err";
  msg: string;
}

export type DeviceToServer = Hello | Telemetry | RigEvent | DeviceAck;
export type ServerToDevice = DeviceCmd | Welcome;
export type ViewerToServer = ViewerCmd;
export type ServerToViewer = StateMsg | Stamped<Telemetry> | Stamped<RigEvent> | DeviceMsg | ViewerAck | BrandMsg | ErrMsg;

// ---------- HTTP ----------
/** GET /api/history?minutes=N  (columnar, <= 600 points, uPlot-ready). */
export interface HistoryResponse {
  /** Bucket size in ms. */
  step: number;
  t: number[];
  m: number[];
  b1i: number[]; b1o: number[];
  b2i: number[]; b2o: number[];
  b3i: number[]; b3o: number[];
  loss1: number[]; loss2: number[]; loss3: number[];
  /** Bitmask per bucket, bit0 = branch 1 (max over the bucket). */
  leak: number[];
  ntu: number[];
  ppm: number[];
}

/** GET /api/status */
export interface StatusResponse extends Omit<StateMsg, "t"> {
  viewers: number;
  /** Telemetry rows currently stored. */
  rows: number;
}

/** GET /api/events?limit=&before=  -> Stamped<RigEvent>[] newest first. */
export type EventsResponse = Stamped<RigEvent>[];

/** POST /api/cmd body is CmdBody; response is ViewerAck without `t`/`cid`. */
export type HttpAck = Omit<ViewerAck, "t" | "cid">;

// ---------- helpers ----------
export function branchFlow(tel: Telemetry, b: Branch): { in: number; out: number } {
  return { in: tel.f[2 * b - 1] ?? 0, out: tel.f[2 * b] ?? 0 };
}

export function lossPct(inLpm: number, outLpm: number): number {
  if (inLpm <= 0) return 0;
  return Math.max(0, ((inLpm - outLpm) / inLpm) * 100);
}

export function isLatched(level: LeakLevel): boolean {
  return level >= 2;
}
