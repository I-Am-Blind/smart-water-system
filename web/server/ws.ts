/**
 * WebSocket hub: one device socket (the rig), many viewer sockets (browsers, mobile).
 * Validates every inbound message with the shared zod schemas, forwards commands to the
 * device with integer ids, maps acks back to the caller by cid, and fans telemetry out.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { DeviceToServerSchema, ViewerToServerSchema } from "@proto/schema";
import {
  ACK_TIMEOUT_MS, ONLINE_TIMEOUT_MS,
  type Brand, type CmdBody, type DeviceCmd, type DeviceMsg, type Hello, type HttpAck, type ServerAckError,
  type Telemetry, type ViewerAck, type Welcome,
} from "@proto/types";
import type { Db } from "./db";
import { log, logError } from "./log";
import type { RigState } from "./state";

const HELLO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 10_000;
const VIEWER_MAX_BUFFER = 256 * 1024;
const MAX_PAYLOAD = 64 * 1024;

type Origin =
  | { kind: "ws"; ws: WebSocket; cid: string }
  | { kind: "http"; resolve: (ack: HttpAck) => void };

interface Pending { origin: Origin; timer: NodeJS.Timeout }

function text(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

export class Hub {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  private viewers = new Set<WebSocket>();
  private device: WebSocket | null = null;
  private alive = new WeakMap<WebSocket, boolean>();
  private pending = new Map<number, Pending>();
  private cmdSeq = 0;
  private lastErrLog = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(private state: RigState, private db: Db) {
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
    this.timers.push(setInterval(() => this.watchdog(), 1000));
    this.timers.push(setInterval(() => this.pingAll(), PING_INTERVAL_MS));
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  get viewerCount(): number { return this.viewers.size; }

  get online(): boolean {
    return this.device !== null && this.device.readyState === WebSocket.OPEN
      && Date.now() - this.state.lastTelAt < ONLINE_TIMEOUT_MS;
  }

  // ---------- connection setup ----------

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    this.alive.set(ws, true);
    ws.on("pong", () => this.alive.set(ws, true));
    ws.on("error", (err) => logError("WS", "socket error", err));
    const role = new URL(req.url ?? "/", "http://localhost").searchParams.get("role");
    if (role === "viewer") this.addViewer(ws);
    else this.awaitHello(ws);
  }

  private addViewer(ws: WebSocket): void {
    this.viewers.add(ws);
    this.sendJson(ws, this.state.snapshot());
    ws.on("message", (data) => this.onViewerMessage(ws, data));
    ws.on("close", () => this.viewers.delete(ws));
  }

  private awaitHello(ws: WebSocket): void {
    const timer = setTimeout(() => ws.close(4001, "hello timeout"), HELLO_TIMEOUT_MS);
    ws.once("message", (data) => {
      clearTimeout(timer);
      const msg = this.parseDevice(ws, data);
      if (!msg || msg.t !== "hello") {
        ws.close(4001, "expected hello");
        return;
      }
      this.adoptDevice(ws, msg);
    });
    ws.on("close", () => clearTimeout(timer));
  }

  private adoptDevice(ws: WebSocket, hello: Hello): void {
    if (this.device && this.device !== ws) {
      log("WS", "device replaced by a new connection");
      const old = this.device;
      this.device = null;
      old.close(4000, "replaced");
    }
    this.device = ws;
    this.state.info = hello;
    log("WS", `device hello id=${hello.id} fw=${hello.fw} ip=${hello.ip} rst=${hello.rst} mon=[${hello.mon.join(",")}]`);
    const welcome: Welcome = { t: "welcome", now: Date.now() };
    this.sendJson(ws, welcome);
    ws.on("message", (data) => {
      const msg = this.parseDevice(ws, data);
      if (msg) this.onDeviceMessage(msg);
    });
    ws.on("close", (code) => {
      if (this.device === ws) {
        this.device = null;
        log("WS", `device disconnected code=${code}`);
        this.setOnline(false);
        this.failAllPending("device_offline");
      }
    });
  }

  // ---------- inbound ----------

  private parseDevice(ws: WebSocket, data: RawData) {
    let raw: unknown;
    try { raw = JSON.parse(text(data)); } catch { this.reject(ws, "device", "not JSON"); return null; }
    const parsed = DeviceToServerSchema.safeParse(raw);
    if (!parsed.success) {
      const t = typeof raw === "object" && raw !== null && "t" in raw ? String((raw as { t: unknown }).t) : "?";
      this.reject(ws, "device", `invalid ${t}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      return null;
    }
    return parsed.data;
  }

  private onDeviceMessage(msg: ReturnType<typeof DeviceToServerSchema.parse>): void {
    const at = Date.now();
    switch (msg.t) {
      case "tel": {
        const stamped = this.state.applyTel(msg, at);
        this.db.bufferTel(stamped);
        this.setOnline(true);
        this.broadcast(stamped, true);
        break;
      }
      case "evt": {
        const stamped = this.state.applyEvt(msg, at);
        this.db.insertEvent(stamped);
        log("EVT", JSON.stringify(msg));
        this.broadcast(stamped, false);
        break;
      }
      case "ack": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        this.deliverAck(p.origin, { ok: msg.ok, err: msg.err, ms: msg.ms });
        break;
      }
      case "hello":
        this.state.info = msg;
        break;
    }
  }

  private onViewerMessage(ws: WebSocket, data: RawData): void {
    let raw: unknown;
    try { raw = JSON.parse(text(data)); } catch { this.reject(ws, "viewer", "not JSON"); return; }
    const parsed = ViewerToServerSchema.safeParse(raw);
    if (!parsed.success) {
      this.reject(ws, "viewer", `invalid cmd: ${parsed.error.issues[0]?.message ?? "schema"}`);
      const cid = typeof raw === "object" && raw !== null && "cid" in raw ? String((raw as { cid: unknown }).cid) : "";
      if (cid) this.sendJson(ws, { t: "ack", cid, ok: false, err: "bad_cmd" } satisfies ViewerAck);
      return;
    }
    const { t: _t, cid, ...body } = parsed.data;
    void _t;
    if (body.act === "valve" && body.b === undefined) {
      this.sendJson(ws, { t: "ack", cid, ok: false, err: "bad_cmd" } satisfies ViewerAck);
      return;
    }
    this.dispatch(body, { kind: "ws", ws, cid });
  }

  private reject(ws: WebSocket, who: string, msg: string): void {
    this.sendJson(ws, { t: "err", msg });
    const now = Date.now();
    if (now - this.lastErrLog > 60_000) {
      this.lastErrLog = now;
      log("WS", `rejected ${who} message: ${msg}`);
    }
  }

  // ---------- commands ----------

  /** Forwards a command to the device and routes the ack back to the origin. */
  dispatch(cmd: CmdBody, origin: Origin): void {
    if (!this.online || !this.device) {
      this.deliverAck(origin, { ok: false, err: "device_offline" });
      return;
    }
    const id = ++this.cmdSeq;
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) this.deliverAck(origin, { ok: false, err: "timeout" });
    }, ACK_TIMEOUT_MS);
    this.pending.set(id, { origin, timer });
    const out: DeviceCmd = { t: "cmd", id, ...cmd };
    log("CMD", `#${id} ${JSON.stringify(cmd)}`);
    this.sendJson(this.device, out);
  }

  private deliverAck(origin: Origin, ack: HttpAck): void {
    if (origin.kind === "http") { origin.resolve(ack); return; }
    const msg: ViewerAck = { t: "ack", cid: origin.cid, ok: ack.ok };
    if (ack.err) msg.err = ack.err;
    if (ack.ms !== undefined) msg.ms = ack.ms;
    this.sendJson(origin.ws, msg);
  }

  private failAllPending(err: ServerAckError): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.deliverAck(p.origin, { ok: false, err });
    }
  }

  // ---------- liveness / fan-out ----------

  private setOnline(online: boolean): void {
    if (this.state.online === online) return;
    this.state.online = online;
    log("WS", online ? "device ONLINE" : "device OFFLINE");
    const msg: DeviceMsg = { t: "device", online, lastSeen: this.state.lastSeen, info: this.state.info };
    this.broadcast(msg, false);
    if (!online) this.db.flush({ tel: this.state.tel, info: this.state.info, lastSeen: this.state.lastSeen });
  }

  private watchdog(): void {
    this.setOnline(this.online);
  }

  private pingAll(): void {
    const all = [...this.viewers, ...(this.device ? [this.device] : [])];
    for (const ws of all) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (this.alive.get(ws) === false) { ws.terminate(); continue; }
      this.alive.set(ws, false);
      ws.ping();
    }
  }

  /** Sends to every viewer. Telemetry is droppable for slow viewers; everything else is not. */
  broadcast(msg: object, droppable: boolean): void {
    const s = JSON.stringify(msg);
    for (const ws of this.viewers) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && ws.bufferedAmount > VIEWER_MAX_BUFFER) continue;
      ws.send(s);
    }
  }

  broadcastBrand(brand: Brand): void {
    this.state.brand = brand;
    this.broadcast({ t: "brand", brand }, false);
  }

  private sendJson(ws: WebSocket, msg: object): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Latest telemetry, for the HTTP layer. */
  get lastTel(): Telemetry | null { return this.state.tel; }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.failAllPending("device_offline");
    for (const ws of this.viewers) ws.close(1001, "server shutdown");
    this.device?.close(1001, "server shutdown");
    this.wss.close();
  }
}
