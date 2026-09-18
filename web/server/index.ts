/**
 * Entry point: one Node process that serves the Next.js UI, the WebSocket hub on /ws,
 * the /api/* JSON routes and the SQLite history, and reads the rig over USB serial when one is
 * plugged in (SERIAL_PORT, see ./serial.ts). Runs unchanged on a laptop or on Render.
 *   dev:   pnpm dev      (tsx watch, Next in development mode)
 *   prod:  pnpm build && pnpm start
 */
import http from "node:http";
import path from "node:path";
import next from "next";
import { handleApi } from "./api";
import { computeServerUrl, loadBrand, watchBranding } from "./branding";
import { Db } from "./db";
import { log, logError } from "./log";
import { startSerial } from "./serial";
import { RigState } from "./state";
import { Hub } from "./ws";

const port = Number(process.env.PORT ?? 3000);
const dev = process.env.NODE_ENV !== "production";
const webDir = path.resolve(import.meta.dirname, "..");

const brand = loadBrand();
const state = new RigState(brand, computeServerUrl(port));
const db = new Db();
const saved = db.rehydrate();
state.tel = saved.tel;
state.info = saved.info;
state.lastSeen = saved.lastSeen;
state.events = saved.events;
if (saved.tel) log("DB", `rehydrated last telemetry from ${new Date(saved.tel.at).toISOString()}`);

const hub = new Hub(state, db);
const app = next({ dev, dir: webDir });
await app.prepare();
const handle = app.getRequestHandler();

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/") && (await handleApi(req, res, { state, db, hub }))) return;
    await handle(req, res);
  } catch (err) {
    logError("HTTP", `${req.method} ${req.url}`, err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error");
  }
});

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/ws") { hub.handleUpgrade(req, socket, head); return; }
  // Next.js attaches its own upgrade listener for /_next/* (dev HMR); everything else is refused.
  if (!pathname.startsWith("/_next")) socket.destroy();
});

const serial = startSerial(hub);
const brandWatcher = watchBranding((b) => hub.broadcastBrand(b));
const flushTimer = setInterval(() => db.flush({ tel: state.tel, info: state.info, lastSeen: state.lastSeen }), 5000);
const pruneTimer = setInterval(() => db.prune(), 10 * 60_000);
db.prune();

server.listen(port, () => {
  log("HTTP", `${brand.name} server listening on http://localhost:${port}  (LAN: ${state.serverUrl}, ws: ${state.serverUrl.replace(/^http/, "ws")}/ws)`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("HTTP", `${signal} received, shutting down`);
  clearInterval(flushTimer);
  clearInterval(pruneTimer);
  brandWatcher?.close();
  serial.close();
  hub.close();
  db.flush({ tel: state.tel, info: state.info, lastSeen: state.lastSeen });
  db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
