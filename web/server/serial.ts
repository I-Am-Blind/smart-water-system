/**
 * USB serial transport for the rig (Arduino Uno). The board speaks the device side of the protocol
 * as newline-delimited JSON, one message per line (docs/PROTOCOL.md §1). This finds the board, reopens
 * it after an unplug, and hands every valid line to the hub; lines that are not JSON are the sketch's
 * own log output and are printed as-is.
 *
 *   SERIAL_PORT=auto (default) | /dev/cu.usbmodem1101 | COM3 | off
 *   SERIAL_BAUD=115200
 */
import type { SerialPort } from "serialport";
import type { ServerToDevice } from "@proto/types";
import { log, logError } from "./log";
import { parseDeviceMessage, type DeviceLink, type Hub } from "./ws";

const RETRY_MS = 2000;
/** Ask for a hello if the board did not reset on open and so never sent one. */
const HELLO_WAIT_MS = 3000;
/**
 * The Uno's receive buffer is 64 bytes and the sketch stops reading for ~25 ms while it prints a
 * tel line, so outgoing lines are spaced out: never more than one line in its buffer at a time.
 */
const WRITE_GAP_MS = 60;
const MAX_LINE = 1024;
/**
 * The board sends a tel line every second. Silence this long means a dead link (cable pulled without
 * the OS saying so, or a hung board): reopen the port, which also resets the Uno.
 */
const SILENT_MS = 10_000;

/** USB vendor ids of the boards and USB-serial chips an Uno (or clone) shows up as. */
const USB_VENDORS = new Set(["2341", "2a03", "1a86", "0403", "10c4", "067b"]);
const PATH_HINT = /usbmodem|usbserial|wchusbserial|ttyACM|ttyUSB/i;

export interface SerialHandle { close(): void }

export function startSerial(hub: Hub): SerialHandle {
  const want = (process.env.SERIAL_PORT ?? "auto").trim();
  const baudRate = Number(process.env.SERIAL_BAUD ?? 115200);
  if (want === "off") {
    log("SER", "serial disabled (SERIAL_PORT=off)");
    return { close() {} };
  }

  let closed = false;
  let port: SerialPort | null = null;
  let retry: NodeJS.Timeout | null = null;
  let helloTimer: NodeJS.Timeout | null = null;
  let gotHello = false;
  let lastAsk = 0;
  let lastBadLog = 0;
  let lastMissLog = 0;
  let rx = "";
  let lastRx = 0;
  const queue: string[] = [];
  let writing = false;

  const link: DeviceLink = {
    name: "serial",
    get open() { return port?.isOpen ?? false; },
    send(msg: ServerToDevice) {
      if (msg.t === "welcome") return; // the Uno has no use for it; save its tiny buffer
      queue.push(JSON.stringify(msg) + "\n");
      pump();
    },
    // A newer device took over. Keep the port: once that one goes quiet we ask the board for a
    // fresh hello and it becomes the device again.
    close() { gotHello = false; },
  };

  function pump(): void {
    if (writing || !port?.isOpen) return;
    const line = queue.shift();
    if (line === undefined) return;
    writing = true;
    port.write(line, (err) => { if (err) logError("SER", "write failed", err); });
    setTimeout(() => { writing = false; pump(); }, WRITE_GAP_MS);
  }

  function askHello(): void {
    const now = Date.now();
    if (!port?.isOpen || now - lastAsk < HELLO_WAIT_MS) return;
    lastAsk = now;
    port.write("?\n");
  }

  function onLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    if (line[0] !== "{") { log("UNO", line); return; }
    const r = parseDeviceMessage(line);
    if (!r.ok) {
      const now = Date.now();
      if (now - lastBadLog > 10_000) { lastBadLog = now; log("SER", `rejected line (${r.err}): ${line.slice(0, 200)}`); }
      return;
    }
    if (r.msg.t === "hello") {
      gotHello = true;
      hub.adoptDevice(link, r.msg);
      return;
    }
    if (!gotHello) { if (!hub.online) askHello(); return; }
    hub.deviceMessage(link, r.msg);
  }

  function onData(chunk: Buffer): void {
    lastRx = Date.now();
    rx += chunk.toString("latin1");
    let nl: number;
    while ((nl = rx.indexOf("\n")) >= 0) {
      onLine(rx.slice(0, nl));
      rx = rx.slice(nl + 1);
    }
    if (rx.length > MAX_LINE) rx = "";
  }

  function schedule(): void {
    if (closed || retry) return;
    retry = setTimeout(() => { retry = null; void connect(); }, RETRY_MS);
  }

  async function findPort(SP: typeof SerialPort): Promise<string | null> {
    if (want !== "auto") return want;
    const ports = await SP.list();
    const hit = ports.find((p) => USB_VENDORS.has((p.vendorId ?? "").toLowerCase()))
      ?? ports.find((p) => PATH_HINT.test(p.path));
    if (!hit) return null;
    // macOS lists /dev/tty.*; the call-out device /dev/cu.* is the one to open.
    return process.platform === "darwin" ? hit.path.replace("/dev/tty.", "/dev/cu.") : hit.path;
  }

  /** Forgets port `p` (if it is still the current one) and starts looking for the board again. */
  function detach(p: SerialPort, why: string): void {
    if (port !== p) return;
    port = null;
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
    queue.length = 0;
    hub.dropDevice(link, `(port ${why})`);
    if (!closed) log("SER", `${p.path} ${why}, reconnecting`);
    schedule();
  }

  let SP: typeof SerialPort | null = null;

  async function connect(): Promise<void> {
    if (closed) return;
    try {
      SP ??= (await import("serialport")).SerialPort;
    } catch (err) {
      logError("SER", "serialport native binding unavailable, serial disabled", err);
      return;
    }
    let path: string | null;
    try {
      path = await findPort(SP);
    } catch (err) {
      logError("SER", "listing ports failed", err);
      schedule();
      return;
    }
    if (!path) {
      const now = Date.now();
      if (now - lastMissLog > 60_000) { lastMissLog = now; log("SER", "no Arduino found on USB, still looking (set SERIAL_PORT to pick one)"); }
      schedule();
      return;
    }

    const p = new SP({ path, baudRate, autoOpen: false });
    p.on("data", onData);
    p.on("error", (err) => logError("SER", `${path} error`, err));
    p.on("close", () => detach(p, "closed"));
    p.open((err) => {
      if (err) {
        const now = Date.now();
        if (now - lastMissLog > 60_000) { lastMissLog = now; logError("SER", `cannot open ${path}`, err); }
        schedule();
        return;
      }
      if (closed) { p.close(); return; }
      port = p;
      gotHello = false;
      rx = "";
      lastRx = Date.now();
      lastAsk = 0;
      lastMissLog = 0;
      log("SER", `opened ${path} @ ${baudRate}`);
      // Opening the port normally resets an Uno, which then sends hello on boot. Ask if it did not.
      helloTimer = setTimeout(() => { helloTimer = null; if (!gotHello) askHello(); }, HELLO_WAIT_MS);
    });
  }

  const watchdog = setInterval(() => {
    const p = port;
    if (!p || Date.now() - lastRx < SILENT_MS) return;
    detach(p, `silent for ${SILENT_MS / 1000} s`);
    if (p.isOpen) p.close(() => { /* a dead link may refuse to close cleanly */ });
  }, 2000);

  void connect();

  return {
    close() {
      closed = true;
      clearInterval(watchdog);
      if (retry) clearTimeout(retry);
      if (helloTimer) clearTimeout(helloTimer);
      if (port?.isOpen) port.close();
    },
  };
}
