/**
 * Fake rig: connects to the server as the device and behaves like the firmware
 * (1 Hz telemetry, on-device leak logic, acks), so the UI and mobile app can be developed
 * and demoed without hardware.
 *
 *   pnpm fake                      connect to ws://localhost:3000/ws
 *   pnpm fake -- --url ws://host:3000/ws --leak 2 --quiet --hz 1
 *   keys (interactive): 1/2/3 toggle an injected leak on a branch, p pump, o go offline 15 s, q quit
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
const initialLeak = Number(flag("leak") ?? "0");
const CTRL_C = "\u0003";

const log = (m: string): void => { if (!quiet) console.log(`[fake] ${m}`); };

// ---------- simulated rig ----------
const BASE_LPM = 0.7;      // per open branch
const LEAK_FRAC = 0.45;    // injected loss fraction
const LEAK_PCT = 20;       // firmware drip threshold, percent
const LEAK_CONFIRM_S = 3;

const valves = [true, true, true];
let pump = true;
const leakInjected = [false, false, false];
const leakLevel: LeakLevel[] = [0, 0, 0];
const leakSecs = [0, 0, 0];
const pulses = [0, 0, 0, 0, 0, 0, 0];
let seq = 0;
let ntu = 12;
let ppm = 310;
const started = Date.now();
const relayOnSince: (number | null)[] = [started, started, started, started]; // v1 v2 v3 pump
if (initialLeak >= 1 && initialLeak <= 3) leakInjected[initialLeak - 1] = true;

const ms = (): number => (Date.now() - started) >>> 0;
const jitter = (v: number, pct: number): number => v * (1 + (Math.random() * 2 - 1) * pct);
const asBranch = (i: number): Branch => (i + 1) as Branch;

let ws: WebSocket | null = null;
let backoff = 1000;
const send = (m: object): void => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const evt = (e: Omit<RigEvent, "t" | "ms">): void => { const full: RigEvent = { t: "evt", ms: ms(), ...e }; log(`evt ${JSON.stringify(e)}`); send(full); };

function setValve(b: number, on: boolean, src: RigEvent["src"], reason?: RigEvent["reason"]): void {
  if (valves[b] === on) return;
  valves[b] = on;
  relayOnSince[b] = on ? Date.now() : null;
  evt({ ev: "valve", b: asBranch(b), on: on ? 1 : 0, src, ...(reason ? { reason } : {}) });
  if (!on && !valves.some(Boolean) && pump) setPump(false, "interlock", "all_closed");
}

function setPump(on: boolean, src: RigEvent["src"], reason?: RigEvent["reason"]): void {
  if (pump === on) return;
  pump = on;
  relayOnSince[3] = on ? Date.now() : null;
  evt({ ev: "pump", on: on ? 1 : 0, src, ...(reason ? { reason } : {}) });
}

function tick(): Telemetry {
  const f = [0, 0, 0, 0, 0, 0, 0];
  const loss = [0, 0, 0];
  for (let b = 0; b < 3; b++) {
    const flowing = pump && valves[b];
    const inL = flowing ? jitter(BASE_LPM, 0.03) : 0;
    const outL = flowing ? inL * (1 - (leakInjected[b] ? LEAK_FRAC : 0.01)) * jitter(1, 0.02) : 0;
    f[2 * b + 1] = inL;
    f[2 * b + 2] = outL;
    if (flowing && inL >= 0.5) {
      loss[b] = Math.max(0, ((inL - outL) / inL) * 100);
      if (loss[b] >= LEAK_PCT) {
        if (++leakSecs[b] >= LEAK_CONFIRM_S && leakLevel[b] < 2) {
          leakLevel[b] = loss[b] >= 50 ? 3 : 2;
          evt({ ev: "leak", b: asBranch(b), kind: leakLevel[b] === 3 ? "burst" : "drip", loss: Math.round(loss[b] * 10) / 10, src: "leak" });
          setValve(b, false, "leak");
        } else if (leakLevel[b] === 0) {
          leakLevel[b] = 1;
        }
      } else if (loss[b] < 10) {
        leakSecs[b] = 0;
        if (leakLevel[b] === 1) leakLevel[b] = 0;
      }
    } else {
      leakSecs[b] = 0;
      if (leakLevel[b] === 1) leakLevel[b] = 0;
    }
  }
  f[0] = (f[1] + f[3] + f[5]) * jitter(1, 0.02);
  for (let i = 0; i < 7; i++) pulses[i] += Math.round(f[i] * HZ_PER_LPM);
  ntu = Math.max(0, ntu + (Math.random() - 0.5) * 0.6);
  ppm = Math.max(0, ppm + (Math.random() - 0.5) * 4);

  // relay max-on watchdogs, like the firmware
  const now = Date.now();
  for (let b = 0; b < 3; b++) {
    const since = relayOnSince[b];
    if (valves[b] && since !== null && now - since > VALVE_MAX_ON_S * 1000) setValve(b, false, "wd", "max_on");
  }
  const pumpSince = relayOnSince[3];
  if (pump && pumpSince !== null && now - pumpSince > PUMP_MAX_ON_S * 1000) setPump(false, "wd", "max_on");

  return {
    t: "tel", ms: ms(), seq: ++seq,
    f: f.map((v) => Math.round(v * 100) / 100),
    p: [...pulses],
    loss: loss.map((v) => Math.round(v * 10) / 10),
    leak: [...leakLevel], mleak: 0,
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
      if (!c.b || c.b < 1 || c.b > 3) { ack(false, "bad_branch"); return; }
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
      for (let b = 0; b < 3; b++) setValve(b, false, "ws");
      setPump(false, "ws");
      evt({ ev: "all_off", src: "ws" });
      ack(true);
      return;
    case "reset_leak":
      for (let b = 0; b < 3; b++) { leakLevel[b] = 0; leakSecs[b] = 0; }
      evt({ ev: "leak_clear", src: "ws" });
      ack(true);
      return;
    case "ping":
      ack(true, undefined, { ms: ms() });
      return;
    case "sim":
      if (c.b && c.b >= 1 && c.b <= 3) leakInjected[c.b - 1] = Boolean(c.on);
      evt({ ev: "sim", on: c.on ? 1 : 0, src: "ws" });
      ack(true);
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
    const hello: Hello = { t: "hello", proto: PROTO_VERSION, id: "sim", fw: "sim-1.0", ip: "127.0.0.1", rssi: -55, rst: "POWERON", sim: true };
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
    if (k === "1" || k === "2" || k === "3") { const b = Number(k) - 1; leakInjected[b] = !leakInjected[b]; log(`leak on branch ${k}: ${leakInjected[b] ? "ON" : "off"}`); }
    if (k === "p") setPump(!pump, "serial");
    if (k === "o") goOffline(15);
  });
  log("keys: 1/2/3 toggle leak, p pump, o offline 15 s, q quit");
}

process.on("SIGTERM", () => process.exit(0));
connect();
