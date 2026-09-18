/**
 * End-to-end smoke test against a RUNNING server (pnpm dev or pnpm start).
 * Spawns the fake device (unless --no-spawn), connects as a viewer and checks the whole loop.
 *   pnpm smoke                 # server on http://localhost:3000
 *   pnpm smoke -- --url http://host:3000 --no-spawn
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { WebSocket } from "ws";
import { SENSOR_KEYS } from "@proto/types";
import type { HistoryResponse, ServerToViewer, Stamped, StatusResponse, Telemetry, ViewerCmd } from "@proto/types";

type Msg<T extends ServerToViewer["t"]> = Extract<ServerToViewer, { t: T }>;

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const base = (flag("url") ?? "http://localhost:3000").replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws") + "/ws";
const noSpawn = args.includes("--no-spawn");

let child: ChildProcess | null = null;
let step = "";
const cleanup = (): void => { child?.kill("SIGTERM"); };
const fail = (msg: string): never => { console.error(`SMOKE FAIL at [${step}]: ${msg}`); cleanup(); process.exit(1); };
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const inbox: ServerToViewer[] = [];
const waiters: { pred: (m: ServerToViewer) => boolean; resolve: (m: ServerToViewer) => void }[] = [];
function expect<T extends ServerToViewer>(pred: (m: ServerToViewer) => m is T, timeoutMs: number, what: string): Promise<T> {
  const idx = inbox.findIndex(pred);
  if (idx >= 0) { const hit = inbox[idx] as T; inbox.splice(idx, 1); return Promise.resolve(hit); }
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => fail(`timed out waiting for ${what}`), timeoutMs);
    waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m as T); } });
  });
}

async function getJson<T>(p: string): Promise<T> {
  const r = await fetch(`${base}${p}`);
  if (!r.ok) fail(`GET ${p} -> ${r.status}`);
  return (await r.json()) as T;
}

async function main(): Promise<void> {
  step = "spawn fake device";
  if (!noSpawn) {
    child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", path.join(import.meta.dirname, "fake-device.ts"), "--quiet", "--url", wsBase], { stdio: "inherit" });
    child.on("exit", (code) => { if (step !== "done" && step !== "device offline") fail(`fake device exited early (${code})`); });
  }

  step = "viewer connect";
  const ws = new WebSocket(`${wsBase}?role=viewer`);
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString()) as ServerToViewer;
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) { const w = waiters[i]; waiters.splice(i, 1); w.resolve(m); } else inbox.push(m);
  });
  ws.on("error", (e) => fail(`viewer socket error: ${e.message}`));
  await new Promise<void>((res) => ws.on("open", () => res()));

  step = "state within 2 s";
  const state = await expect((m): m is Msg<"state"> => m.t === "state", 2000, "state");
  if (!state.brand?.name) fail("state.brand missing");
  if (!state.serverUrl) fail("state.serverUrl missing");
  console.log(`  state ok (brand=${state.brand.name}, online=${state.online}, serverUrl=${state.serverUrl})`);

  step = "device online within 8 s";
  if (!state.online) await expect((m): m is Msg<"device"> => m.t === "device" && m.online, 8000, "device online");
  const tel1 = await expect((m): m is Stamped<Telemetry> => m.t === "tel", 3000, "first tel");
  if (tel1.f.length !== SENSOR_KEYS.length) fail(`tel.f length ${tel1.f.length}, expected ${SENSOR_KEYS.length}`);
  console.log(`  online, tel seq=${tel1.seq}`);

  const sendCmd = (c: Omit<ViewerCmd, "t">): void => { ws.send(JSON.stringify({ t: "cmd", ...c } satisfies ViewerCmd)); };
  const ackFor = (cid: string): Promise<Msg<"ack">> => expect((m): m is Msg<"ack"> => m.t === "ack" && m.cid === cid, 3000, `ack ${cid}`);

  // The rig boots in automatic mode, where valve commands are refused: check that, then go manual.
  step = "valve refused in auto mode";
  sendCmd({ cid: "s0", act: "valve", b: 2, on: true });
  const ack0 = await ackFor("s0");
  if (ack0.ok || ack0.err !== "auto_mode") fail(`valve in auto mode: expected auto_mode, got ${JSON.stringify(ack0)}`);
  step = "switch to manual";
  sendCmd({ cid: "s0m", act: "auto", on: false });
  const ackM = await ackFor("s0m");
  if (!ackM.ok) fail(`manual mode not acked: ${ackM.err}`);
  await expect((m): m is Msg<"evt"> => m.t === "evt" && m.ev === "mode" && m.on === 0, 3000, "evt mode manual");
  await expect((m): m is Stamped<Telemetry> => m.t === "tel" && m.auto === 0, 3000, "tel with auto=0");
  console.log("  valve refused in auto mode, switched to manual");

  // Branch 2 is the backup: it starts closed, so opening then closing it exercises both directions.
  step = "valve open ack";
  sendCmd({ cid: "s1", act: "valve", b: 2, on: true });
  const ack1 = await ackFor("s1");
  if (!ack1.ok) fail(`ack s1 not ok: ${ack1.err}`);
  step = "tel reflects valve 2 open";
  await expect((m): m is Stamped<Telemetry> => m.t === "tel" && m.v[1] === 1, 3000, "tel with v[1]=1");
  console.log("  valve 2 opened and reflected in tel");

  step = "valve close";
  sendCmd({ cid: "s2", act: "valve", b: 2, on: false });
  const ack2 = await ackFor("s2");
  if (!ack2.ok) fail(`ack s2 not ok: ${ack2.err}`);
  await expect((m): m is Stamped<Telemetry> => m.t === "tel" && m.v[1] === 0, 3000, "tel with v[1]=0");

  step = "all_off";
  sendCmd({ cid: "s3", act: "all_off" });
  const ack3 = await ackFor("s3");
  if (!ack3.ok) fail(`ack s3 not ok: ${ack3.err}`);
  await expect((m): m is Stamped<Telemetry> => m.t === "tel" && m.pump === 0 && m.v.every((v) => v === 0), 3000, "tel all off");
  await expect((m): m is Msg<"evt"> => m.t === "evt" && m.ev === "all_off", 3000, "evt all_off");
  console.log("  all_off acked, tel and evt reflect it");

  step = "bad cmd rejected";
  ws.send(JSON.stringify({ t: "cmd", cid: "s4", act: "nope" }));
  const ack4 = await ackFor("s4");
  if (ack4.ok || ack4.err !== "bad_cmd") fail("bad cmd was not rejected with bad_cmd");

  step = "GET /api/status";
  const status = await getJson<StatusResponse>("/api/status");
  if (status.online !== true) fail("status.online is not true");
  if (typeof status.viewers !== "number") fail("status.viewers missing");
  if (!status.serverUrl) fail("status.serverUrl missing");
  step = "GET /api/history";
  const hist = await getJson<HistoryResponse>("/api/history?minutes=5");
  if (!Array.isArray(hist.t) || hist.t.length > 600) fail("history shape");
  step = "GET /api/events";
  const events = await getJson<unknown[]>("/api/events?limit=10");
  if (!Array.isArray(events)) fail("events not array");
  step = "GET /api/branding";
  const brand = await getJson<{ name?: string }>("/api/branding");
  if (!brand.name) fail("branding.name missing");
  step = "GET /api/qr.svg";
  const qr = await fetch(`${base}/api/qr.svg`);
  if (qr.status !== 200 || !(qr.headers.get("content-type") ?? "").includes("svg")) fail(`qr status ${qr.status}`);
  step = "POST /api/cmd";
  const httpAck = await fetch(`${base}/api/cmd`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ act: "ping" }) });
  if (httpAck.status !== 200) fail(`POST /api/cmd status ${httpAck.status}`);
  const bad = await fetch(`${base}/api/cmd`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
  if (bad.status !== 400) fail(`POST /api/cmd bad body status ${bad.status}`);
  console.log(`  http ok (viewers=${status.viewers}, rows=${status.rows}, history points=${hist.t.length}, events=${events.length})`);

  step = "device offline";
  if (child) {
    child.kill("SIGTERM");
    await expect((m): m is Msg<"device"> => m.t === "device" && !m.online, 8000, "device offline");
    console.log("  offline detected after fake device exit");
    const st2 = await getJson<StatusResponse>("/api/status");
    if (st2.online) fail("status still online after device exit");
    if (!st2.tel) fail("last known tel lost after device exit");
    const offlineAck = await fetch(`${base}/api/cmd`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ act: "ping" }) });
    if (offlineAck.status !== 503) fail(`POST /api/cmd while offline -> ${offlineAck.status}, expected 503`);
  } else {
    console.log("  (skipped offline check: --no-spawn)");
  }

  step = "done";
  ws.close();
  await wait(100);
  console.log("SMOKE OK");
  cleanup();
  process.exit(0);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
