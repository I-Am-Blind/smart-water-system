/**
 * Fake rig: connects to the server as the device and behaves like the firmware
 * (1 Hz telemetry, on-device leak logic, acks), so the UI and mobile app can be developed
 * and demoed without hardware.
 *
 *   pnpm fake                      connect to ws://localhost:3000/ws
 *   pnpm fake -- --url ws://host:3000/ws --leak --quiet --hz 1
 *   keys (interactive): l toggle the injected leak, 1/2 toggle a valve, p pump, o go offline 15 s, q quit
 *
 * Two branches, one metered: branch 1 has the IN/OUT pair, branch 2 is a valve only.
 * A confirmed leak closes branch 1 and fails over to branch 2, like the firmware.
 */
import { WebSocket } from "ws";
import {
  HZ_PER_LPM, PROTO_VERSION, PUMP_MAX_ON_S, VALVE_MAX_ON_S,
  type Branch, type DeviceAck, type DeviceCmd, type Hello, type LeakLevel, type OnOff, type RigEvent, type ServerToDevice, type Telemetry,
} from "@proto/types";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string): boolean => args.includes(`--${name}`);

const url = flag("url") ?? "ws://localhost:3000/ws";
const quiet = has("quiet");
const hz = Number(flag("hz") ?? "1");
const initialLeak = has("leak");
const CTRL_C = "\u0003";

const log = (m: string): void => { if (!quiet) console.log(`[fake] ${m}`); };

// ---------- simulated rig ----------
const BASE_LPM = 0.7;      // per open branch
const LEAK_FRAC = 0.45;    // injected loss fraction
const LEAK_PCT = 20;       // firmware drip threshold, percent
const LEAK_CONFIRM_S = 3;

const valves = [true, false];        // branch 2 is the backup: closed until a failover or a command
let pump = true;
let leakInjected = initialLeak;      // only branch 1 can leak: it is the only one with meters
const leakLevel: LeakLevel[] = [0, 0];
let leakSecs = 0;
const pulses = [0, 0];               // b1i, b1o
let seq = 0;
let ntu = 12;
let ppm = 310;
const started = Date.now();
const relayOnSince: (number | null)[] = [started, null, started]; // v1, v2, pump
const PUMP_IDX = 2;

const ms = (): number => (Date.now() - started) >>> 0;
const jitter = (v: number, pct: number): number => v * (1 + (Math.random() * 2 - 1) * pct);
const asBranch = (i: number): Branch => (i + 1) as Branch;

let ws: WebSocket | null = null;
let backoff = 1000;
const send = (m: object): void => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const evt = (e: Omit<RigEvent, "t" | "ms">): void => { const full: RigEvent = { t: "evt", ms: ms(), ...e }; log(`evt ${JSON.stringify(e)}`); send(full); };

/** Suspends the "no open valve -> stop the pump" interlock across a failover, as the firmware does. */
let holdInterlock = false;

function pumpInterlock(): void {
  if (!holdInterlock && pump && !valves.some(Boolean)) setPump(false, "interlock", "all_closed");
}

function setValve(b: number, on: boolean, src: RigEvent["src"], reason?: RigEvent["reason"]): void {
  if (valves[b] === on) return;
  valves[b] = on;
  relayOnSince[b] = on ? Date.now() : null;
  evt({ ev: "valve", b: asBranch(b), on: on ? 1 : 0, src, ...(reason ? { reason } : {}) });
  pumpInterlock();
}

function setPump(on: boolean, src: RigEvent["src"], reason?: RigEvent["reason"]): void {
  if (pump === on) return;
  pump = on;
  relayOnSince[PUMP_IDX] = on ? Date.now() : null;
  evt({ ev: "pump", on: on ? 1 : 0, src, ...(reason ? { reason } : {}) });
}

/** Closes the leaking branch and opens the backup one, with the interlock held across the gap. */
function failover(kind: "drip" | "burst", loss: number): void {
  leakLevel[0] = kind === "burst" ? 3 : 2;
  evt({ ev: "leak", b: 1, kind, loss: Math.round(loss * 10) / 10, src: "leak" });
  holdInterlock = true;
  setValve(0, false, "leak");
  setValve(1, true, "leak", "failover");
  holdInterlock = false;
  pumpInterlock();
}

function tick(): Telemetry {
  // Only branch 1 is metered, so `f` and `loss` carry its numbers and branch 2 stays at 0.
  const flowing = pump && valves[0];
  const inL = flowing ? jitter(BASE_LPM, 0.03) : 0;
  const outL = flowing ? inL * (1 - (leakInjected ? LEAK_FRAC : 0.01)) * jitter(1, 0.02) : 0;
  const f = [inL, outL];
  const loss = [0, 0];
  if (flowing && inL >= 0.5) {
    loss[0] = Math.max(0, ((inL - outL) / inL) * 100);
    if (loss[0] >= LEAK_PCT) {
      if (++leakSecs >= LEAK_CONFIRM_S && leakLevel[0] < 2) {
        failover(loss[0] >= 50 ? "burst" : "drip", loss[0]);
      } else if (leakLevel[0] === 0) {
        leakLevel[0] = 1;
      }
    } else if (loss[0] < 10) {
      leakSecs = 0;
      if (leakLevel[0] === 1) leakLevel[0] = 0;
    }
  } else {
    leakSecs = 0;
    if (leakLevel[0] === 1) leakLevel[0] = 0;
  }
  for (let i = 0; i < pulses.length; i++) pulses[i] += Math.round(f[i] * HZ_PER_LPM);
  ntu = Math.max(0, ntu + (Math.random() - 0.5) * 0.6);
  ppm = Math.max(0, ppm + (Math.random() - 0.5) * 4);

  // relay max-on watchdogs, like the firmware
  const now = Date.now();
  for (let b = 0; b < valves.length; b++) {
    const since = relayOnSince[b];
    if (valves[b] && since !== null && now - since > VALVE_MAX_ON_S * 1000) setValve(b, false, "wd", "max_on");
  }
  const pumpSince = relayOnSince[PUMP_IDX];
  if (pump && pumpSince !== null && now - pumpSince > PUMP_MAX_ON_S * 1000) setPump(false, "wd", "max_on");

  return {
    t: "tel", ms: ms(), seq: ++seq,
    f: f.map((v) => Math.round(v * 100) / 100),
    p: [...pulses],
    loss: loss.map((v) => Math.round(v * 10) / 10),
    leak: [...leakLevel],
    v: valves.map((v): OnOff => (v ? 1 : 0)), pump: pump ? 1 : 0,
    turb: { mv: Math.round(2900 - ntu * 20), ntu: Math.round(ntu) },
    tds: { mv: Math.round(ppm * 1.35), ppm: Math.round(ppm) },
    rssi: -55 - Math.round(Math.random() * 6),
    up: Math.floor((now - started) / 1000),
    heap: 210000 + Math.round(Math.random() * 3000),
    sim: true,
  };
}

function handleCmd(c: DeviceCmd): void {
  const ack = (ok: boolean, err?: DeviceAck["err"], extra?: Partial<DeviceAck>): void => {
    const a: DeviceAck = { t: "ack", id: c.id, ok, ...(err ? { err } : {}), ...extra };
    setTimeout(() => send(a), 50);
  };
  log(`cmd ${JSON.stringify(c)}`);
  switch (c.act) {
    case "valve": {
      if (!c.b || c.b < 1 || c.b > valves.length) { ack(false, "bad_branch"); return; }
      const b = c.b - 1;
      if (c.on && leakLevel[b] >= 2) { ack(false, "latched"); return; }
      setValve(b, Boolean(c.on), "ws");
      ack(true);
      return;
    }
    case "pump":
      if (c.on && !valves.some(Boolean)) { ack(false, "no_open_valve"); return; }
      setPump(Boolean(c.on), "ws");
      ack(true);
      return;
    case "all_off":
      holdInterlock = true;
      for (let b = 0; b < valves.length; b++) setValve(b, false, "ws");
      holdInterlock = false;
      setPump(false, "ws");
      evt({ ev: "all_off", src: "ws" });
      ack(true);
      return;
    case "reset_leak":
      leakLevel.fill(0);
      leakSecs = 0;
      evt({ ev: "leak_clear", src: "ws" });
      ack(true);
      return;
    case "ping":
      ack(true, undefined, { ms: ms() });
      return;
    default:
      ack(false, "unknown_act");
  }
}

// ---------- connection ----------
let telTimer: NodeJS.Timeout | null = null;
let offlineUntil = 0;

function connect(): void {
  if (Date.now() < offlineUntil) { setTimeout(connect, offlineUntil - Date.now()); return; }
  log(`connecting ${url}`);
  const sock = new WebSocket(url);
  ws = sock;
  sock.on("open", () => {
    backoff = 1000;
    const hello: Hello = {
      t: "hello", proto: PROTO_VERSION, id: "sim", fw: "sim-1.0",
      ip: "127.0.0.1", rssi: -55, rst: "POWERON", mon: [1, 0], sim: true,
    };
    sock.send(JSON.stringify(hello));
    log("connected, hello sent");
    if (telTimer) clearInterval(telTimer);
    telTimer = setInterval(() => send(tick()), Math.max(100, 1000 / hz));
  });
  sock.on("message", (data) => {
    let m: ServerToDevice;
    try { m = JSON.parse(data.toString()) as ServerToDevice; } catch { return; }
    if (m.t === "cmd") handleCmd(m);
  });
  sock.on("close", (code) => {
    if (ws !== sock) return;
    ws = null;
    if (telTimer) { clearInterval(telTimer); telTimer = null; }
    log(`disconnected (${code}), retry in ${backoff} ms`);
    setTimeout(connect, backoff);
    backoff = Math.min(10000, backoff * 2);
  });
  sock.on("error", (e) => log(`socket error: ${e.message}`));
}

function goOffline(secs: number): void {
  offlineUntil = Date.now() + secs * 1000;
  log(`going offline for ${secs}s`);
  ws?.close();
}

if (process.stdin.isTTY && !quiet) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (k: string) => {
    if (k === "q" || k === CTRL_C) { console.log(); process.exit(0); }
    if (k === "l") { leakInjected = !leakInjected; log(`injected leak: ${leakInjected ? "ON" : "off"}`); }
    if (k === "1" || k === "2") { const b = Number(k) - 1; setValve(b, !valves[b], "serial"); }
    if (k === "p") setPump(!pump, "serial");
    if (k === "o") goOffline(15);
  });
  log("keys: l toggle leak, 1/2 toggle a valve, p pump, o offline 15 s, q quit");
}

process.on("SIGTERM", () => process.exit(0));
connect();
