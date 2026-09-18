/**
 * Wire contract v1 for the leak-detection rig. Pure TypeScript: no runtime deps,
 * safe to import from the Next.js client bundle and from the Expo app.
 * The human-readable version is docs/PROTOCOL.md; zod validators are in ./schema.ts.
 *
 * The rig has TWO lanes and ONE working IN/OUT flow pair:
 *  - branch 1 is monitored: its own IN and OUT sensors feed leak detection.
 *  - branch 2 is valve-only: a solenoid the operator (or a failover) can open and close,
 *    with no flow sensing of any kind. Its `loss` / `leak` entries are always 0 and must be
 *    rendered as "no data", never as a measurement. `hello.mon` is the runtime source of truth.
 * There is no master/manifold sensor.
 *
 * Conventions
 *  - Every message has a `t` discriminator. Unknown `t` must be ignored.
 *  - Sensor arrays `f` / `p` are ordered [b1i, b1o].
 *  - Branch arrays (`loss`, `leak`, `v`) are index 0..1 = branch 1..2.
 *  - A scalar branch field `b` is 1 or 2.
 */

export const PROTO_VERSION = 1 as const;
export const WS_PATH = "/ws";
export const VIEWER_QUERY = "?role=viewer";
export const DEFAULT_WS_URL = "ws://192.168.0.8:3000/ws";

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

export const SENSOR_KEYS = ["b1i", "b1o"] as const;
export type SensorKey = (typeof SENSOR_KEYS)[number];
export const SENSOR_INDEX: Record<SensorKey, number> = { b1i: 0, b1o: 1 };

export const BRANCHES = [1, 2] as const;
export type Branch = (typeof BRANCHES)[number];
export type OnOff = 0 | 1;

/** The branch whose IN/OUT pair drives leak detection. */
export const MONITORED_BRANCH = 1 satisfies Branch;
/** Which branches have flow sensing, in branch order. Overridden at runtime by `hello.mon`. */
export const DEFAULT_MON: readonly OnOff[] = [1, 0];

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
  branches: [string, string];
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
  /** Which branches have flow sensing (1) and which are valve-only (0), in branch order. */
  mon: OnOff[];
  /** True when the sender is the fake device (web/scripts/fake-device.ts), not real hardware. */
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
  /** Loss % = (in - out) / in * 100 over the 3 s window; 0 when gated off or the branch has no sensing. */
  loss: number[];
  /** Per-branch leak level; always 0 for a branch with no flow sensing. */
  leak: LeakLevel[];
  /** Valve relay states, 1 = valve open (relay energised). */
  v: OnOff[];
  pump: OnOff;
  /**
   * 1 = automatic: the rig keeps branch 1 open and fails over to branch 2 on a leak; valve commands
   * are refused. 0 = manual: leaks are still detected and reported, the operator drives the valves.
   */
  auto: OnOff;
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

export type EventKind = "boot" | "leak" | "leak_clear" | "valve" | "pump" | "all_off" | "mode";
export type EventSource = "serial" | "ws" | "leak" | "wd" | "interlock" | "boot";
export type EventReason = "max_on" | "all_closed" | "failover";
export type LeakKind = "drip" | "burst";

export interface RigEvent {
  t: "evt";
  ms: number;
  ev: EventKind;
  b?: Branch;
  kind?: LeakKind;
  /** Loss % at the moment of the event (leak). */
  loss?: number;
  /** New state for valve / pump events; for `mode`, 1 = automatic and 0 = manual. */
  on?: OnOff;
  src: EventSource;
  reason?: EventReason;
}

/** `auto_mode`: a valve command arrived while the rig is in automatic mode. */
export type DeviceAckError = "latched" | "bad_branch" | "no_open_valve" | "unknown_act" | "bad_json" | "auto_mode";

export interface DeviceAck {
  t: "ack";
  id: number;
  ok: boolean;
  err?: DeviceAckError;
  /** Device millis(), included in every successful ack. */
  ms?: number;
}

// ---------- commands ----------
export type CmdAct = "valve" | "pump" | "all_off" | "reset_leak" | "ping" | "auto";

export interface CmdBody {
  act: CmdAct;
  /** Required for valve. */
  b?: Branch;
  /** valve / pump: desired state. auto: true = automatic mode, false = manual. */
  on?: boolean;
  /** Seconds the relay may stay on (valve <= 600, pump <= 300; 0/absent = firmware default). */
  dur?: number;
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
  b1i: number[];
  b1o: number[];
  loss1: number[];
  /** Highest leak level of the monitored branch in the bucket (0..3). */
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
/** True when branch `b` has flow sensing. Pass `hello.mon` when a device is connected. */
export function isMonitored(b: Branch, mon: readonly OnOff[] = DEFAULT_MON): boolean {
  return mon[b - 1] === 1;
}

/** IN/OUT flow for a monitored branch, or null for a valve-only branch. */
export function branchFlow(tel: Telemetry, b: Branch, mon: readonly OnOff[] = DEFAULT_MON): { in: number; out: number } | null {
  if (!isMonitored(b, mon)) return null;
  return { in: tel.f[0] ?? 0, out: tel.f[1] ?? 0 };
}

export function lossPct(inLpm: number, outLpm: number): number {
  if (inLpm <= 0) return 0;
  return Math.max(0, ((inLpm - outLpm) / inLpm) * 100);
}

export function isLatched(level: LeakLevel): boolean {
  return level >= 2;
}
