/** Small hand-rolled JSON API on the same port as Next.js. Returns true when it handled the request. */
import type { IncomingMessage, ServerResponse } from "node:http";
import QRCode from "qrcode";
import { CmdBodySchema } from "@proto/schema";
import type { HttpAck, StatusResponse } from "@proto/types";
import type { Db } from "./db";
import type { Hub } from "./ws";
import { logError } from "./log";
import type { RigState } from "./state";

export interface ApiContext { state: RigState; db: Db; hub: Hub }

const MAX_BODY = 4096;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const method = req.method ?? "GET";

  if (p === "/api/status" && method === "GET") {
    const { t: _t, ...snap } = ctx.state.snapshot();
    void _t;
    const body: StatusResponse = { ...snap, viewers: ctx.hub.viewerCount, rows: ctx.db.rowCount() };
    json(res, 200, body);
    return true;
  }

  if (p === "/api/history" && method === "GET") {
    const minutes = Number(url.searchParams.get("minutes") ?? "30");
    json(res, 200, ctx.db.history(Number.isFinite(minutes) ? minutes : 30));
    return true;
  }

  if (p === "/api/events" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const before = url.searchParams.get("before");
    json(res, 200, ctx.db.events(Number.isFinite(limit) ? limit : 100, before ? Number(before) : undefined));
    return true;
  }

  if (p === "/api/branding" && method === "GET") {
    json(res, 200, ctx.state.brand);
    return true;
  }

  if (p === "/api/qr.svg" && method === "GET") {
    try {
      const svg = await QRCode.toString(ctx.state.serverUrl, {
        type: "svg", margin: 1, color: { dark: "#e6f8ff", light: "#00000000" },
      });
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      res.end(svg);
    } catch (err) {
      logError("API", "qr failed", err);
      res.writeHead(500).end();
    }
    return true;
  }

  if (p === "/api/cmd" && method === "POST") {
    let raw: unknown;
    try { raw = JSON.parse(await readBody(req)); } catch { json(res, 400, { ok: false, err: "bad_cmd" }); return true; }
    const parsed = CmdBodySchema.safeParse(raw);
    if (!parsed.success) { json(res, 400, { ok: false, err: "bad_cmd" }); return true; }
    const ack = await new Promise<HttpAck>((resolve) => ctx.hub.dispatch(parsed.data, { kind: "http", resolve }));
    const status = ack.err === "device_offline" ? 503 : ack.err === "timeout" ? 504 : 200;
    json(res, status, ack);
    return true;
  }

  if (p.startsWith("/api/")) {
    json(res, 404, { ok: false, err: "not_found" });
    return true;
  }
  return false;
}
