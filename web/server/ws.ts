/**
 * Hub: one device (the rig), many viewer sockets (browsers, mobile).
 * The device arrives either as a WebSocket on /ws or over USB serial (./serial.ts); both are a
 * DeviceLink here. Validates every inbound message with the shared zod schemas, forwards commands
 * to the device with integer ids, maps acks back to the caller by cid, and fans telemetry out.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { DeviceToServerSchema, ViewerToServerSchema } from "@proto/schema";
import {
  ACK_TIMEOUT_MS, ONLINE_TIMEOUT_MS,
  type Brand, type CmdBody, type DeviceCmd, type DeviceMsg, type DeviceToServer, type Hello, type HttpAck,
  type ServerAckError, type ServerToDevice, type Telemetry, type ViewerAck, type Welcome,
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

/** The connected rig, whichever transport it arrived on. */
export interface DeviceLink {
  /** For logs: "ws" or the serial port path. */
  readonly name: string;
  readonly open: boolean;
  send(msg: ServerToDevice): void;
  /** Drops the link because a newer device took over. */
  close(reason: string): void;
}

/** Parses and validates one device message (a WebSocket frame or a serial line). */
export function parseDeviceMessage(s: string): { ok: true; msg: DeviceToServer } | { ok: false; err: string } {
  let raw: unknown;
  try { raw = JSON.parse(s); } catch { return { ok: false, err: "not JSON" }; }
  const parsed = DeviceToServerSchema.safeParse(raw);
  if (parsed.success) return { ok: true, msg: parsed.data };
  const t = typeof raw === "object" && raw !== null && "t" in raw ? String((raw as { t: unknown }).t) : "?";
  return { ok: false, err: `invalid ${t}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` };
}

function text(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

export class Hub {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  private viewers = new Set<WebSocket>();
  private device: DeviceLink | null = null;
  /** Sockets that connected in the device role, for the ping sweep. */
  private deviceSockets = new Set<WebSocket>();
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
    return this.device !== null && this.device.open
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
    this.deviceSockets.add(ws);
    const timer = setTimeout(() => ws.close(4001, "hello timeout"), HELLO_TIMEOUT_MS);
    ws.once("message", (data) => {
      clearTimeout(timer);
      const msg = this.parseDevice(ws, data);
      if (!msg || msg.t !== "hello") {
        ws.close(4001, "expected hello");
        return;
      }
      const link: DeviceLink = {
        name: "ws",
        get open() { return ws.readyState === WebSocket.OPEN; },
        send: (m) => this.sendJson(ws, m),
        close: (reason) => ws.close(4000, reason),
      };
      this.adoptDevice(link, msg);
      ws.on("message", (d) => {
        const m = this.parseDevice(ws, d);
        if (m) this.deviceMessage(link, m);
      });
      ws.on("close", (code) => this.dropDevice(link, `code=${code}`));
    });
    ws.on("close", () => {
      clearTimeout(timer);
      this.deviceSockets.delete(ws);
    });
  }

  /** Makes `link` the device (a newer one replaces an older one). Called again on every hello. */
  adoptDevice(link: DeviceLink, hello: Hello): void {
    if (this.device && this.device !== link) {
      log("DEV", `device on ${this.device.name} replaced by ${link.name}`);
      const old = this.device;
      this.device = null;
      old.close("replaced");
    }
    this.device = link;
    this.state.info = hello;
    log("DEV", `hello via ${link.name} id=${hello.id} fw=${hello.fw} ip=${hello.ip} rst=${hello.rst} mon=[${hello.mon.join(",")}]`);
    const welcome: Welcome = { t: "welcome", now: Date.now() };
    link.send(welcome);
  }

  /** The device's link went away (socket closed, cable pulled). No-op for a link that was already replaced. */
  dropDevice(link: DeviceLink, why: string): void {
    if (this.device !== link) return;
    this.device = null;
    log("DEV", `device on ${link.name} disconnected ${why}`);
    this.setOnline(false);
    this.failAllPending("device_offline");
  }

  // ---------- inbound ----------

  private parseDevice(ws: WebSocket, data: RawData): DeviceToServer | null {
    const r = parseDeviceMessage(text(data));
    if (r.ok) return r.msg;
    this.reject(ws, "device", r.err);
    return null;
  }

  /** Handles a validated message from `link`; ignored unless `link` is the current device. */
  deviceMessage(link: DeviceLink, msg: DeviceToServer): void {
    if (this.device !== link) return;
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
    this.device.send(out);
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
    log("DEV", online ? "device ONLINE" : "device OFFLINE");
    const msg: DeviceMsg = { t: "device", online, lastSeen: this.state.lastSeen, info: this.state.info };
    this.broadcast(msg, false);
    if (!online) this.db.flush({ tel: this.state.tel, info: this.state.info, lastSeen: this.state.lastSeen });
  }

  private watchdog(): void {
    this.setOnline(this.online);
  }

  private pingAll(): void {
    const all = [...this.viewers, ...this.deviceSockets];
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
    for (const ws of this.deviceSockets) ws.close(1001, "server shutdown");
    this.wss.close();
  }
}
