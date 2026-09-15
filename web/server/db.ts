/**
 * SQLite persistence via node:sqlite (built into Node 22, no native build step).
 * Telemetry rows are buffered and written in one transaction every few seconds.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Hello, HistoryResponse, RigEvent, Stamped, Telemetry } from "@proto/types";
import { logError } from "./log";

export const DB_PATH = path.join(import.meta.dirname, "..", "data", "rig.db");
const TEL_RETENTION_MS = 24 * 3600_000;
const EVT_RETENTION_MS = 7 * 24 * 3600_000;
const MAX_POINTS = 600;
const FLUSH_AT = 30; // rows buffered before an early flush

const DDL = `
CREATE TABLE IF NOT EXISTS telemetry(
  at INTEGER PRIMARY KEY,
  m REAL, b1i REAL, b1o REAL, b2i REAL, b2o REAL, b3i REAL, b3o REAL,
  loss1 REAL, loss2 REAL, loss3 REAL,
  leak INTEGER, valve INTEGER, pump INTEGER,
  ntu REAL, ppm REAL, rssi INTEGER
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  branch INTEGER,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface Rehydrated {
  tel: Stamped<Telemetry> | null;
  info: Hello | null;
  lastSeen: number | null;
  events: Stamped<RigEvent>[];
}

export interface MetaSnapshot {
  tel: Stamped<Telemetry> | null;
  info: Hello | null;
  lastSeen: number | null;
}

const HISTORY_COLS = ["m", "b1i", "b1o", "b2i", "b2o", "b3i", "b3o", "loss1", "loss2", "loss3", "leak", "ntu", "ppm"] as const;
type HistoryCol = (typeof HISTORY_COLS)[number];

function bitmask(arr: number[], predicate: (v: number) => boolean): number {
  let mask = 0;
  arr.forEach((v, i) => { if (predicate(v)) mask |= 1 << i; });
  return mask;
}

export class Db {
  private db: DatabaseSync;
  private buf: Stamped<Telemetry>[] = [];
  private insTel: StatementSync;
  private insEvt: StatementSync;
  private setMeta: StatementSync;
  private getMeta: StatementSync;

  constructor(file: string = DB_PATH) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.db.exec(DDL);
    this.insTel = this.db.prepare(
      `INSERT OR IGNORE INTO telemetry(at,m,b1i,b1o,b2i,b2o,b3i,b3o,loss1,loss2,loss3,leak,valve,pump,ntu,ppm,rssi)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.insEvt = this.db.prepare("INSERT INTO events(at,kind,branch,json) VALUES (?,?,?,?)");
    this.setMeta = this.db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    this.getMeta = this.db.prepare("SELECT value FROM meta WHERE key = ?");
  }

  bufferTel(tel: Stamped<Telemetry>): void {
    this.buf.push(tel);
    if (this.buf.length >= FLUSH_AT) this.flush();
  }

  /** Writes buffered telemetry (and optionally the latest-state meta) in one transaction. */
  flush(meta?: MetaSnapshot): void {
    if (this.buf.length === 0 && !meta) return;
    const rows = this.buf;
    this.buf = [];
    this.db.exec("BEGIN");
    try {
      for (const t of rows) {
        this.insTel.run(
          t.at, t.f[0], t.f[1], t.f[2], t.f[3], t.f[4], t.f[5], t.f[6],
          t.loss[0], t.loss[1], t.loss[2],
          bitmask(t.leak, (v) => v >= 1), bitmask(t.v, (v) => v === 1), t.pump,
          t.turb.ntu, t.tds.ppm, t.rssi,
        );
      }
      if (meta) {
        this.setMeta.run("last_tel", JSON.stringify(meta.tel));
        this.setMeta.run("info", JSON.stringify(meta.info));
        this.setMeta.run("last_seen", JSON.stringify(meta.lastSeen));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      logError("DB", "flush failed", err);
    }
  }

  insertEvent(evt: Stamped<RigEvent>): void {
    try {
      this.insEvt.run(evt.at, evt.ev, evt.b ?? null, JSON.stringify(evt));
    } catch (err) {
      logError("DB", "insert event failed", err);
    }
  }

  prune(now: number = Date.now()): void {
    try {
      this.db.prepare("DELETE FROM telemetry WHERE at < ?").run(now - TEL_RETENTION_MS);
      this.db.prepare("DELETE FROM events WHERE at < ?").run(now - EVT_RETENTION_MS);
    } catch (err) {
      logError("DB", "prune failed", err);
    }
  }

  rehydrate(): Rehydrated {
    const read = <T,>(key: string): T | null => {
      const row = this.getMeta.get(key) as { value: string } | undefined;
      if (!row) return null;
      try { return JSON.parse(row.value) as T; } catch { return null; }
    };
    return {
      tel: read<Stamped<Telemetry>>("last_tel"),
      info: read<Hello>("info"),
      lastSeen: read<number>("last_seen"),
      events: this.events(50),
    };
  }

  events(limit: number, before?: number): Stamped<RigEvent>[] {
    const lim = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = (before
      ? this.db.prepare("SELECT json FROM events WHERE at < ? ORDER BY at DESC, id DESC LIMIT ?").all(before, lim)
      : this.db.prepare("SELECT json FROM events ORDER BY at DESC, id DESC LIMIT ?").all(lim)) as { json: string }[];
    const out: Stamped<RigEvent>[] = [];
    for (const r of rows) {
      try { out.push(JSON.parse(r.json) as Stamped<RigEvent>); } catch { /* skip corrupt row */ }
    }
    return out;
  }

  /** Bucketed averages over the last N minutes, at most MAX_POINTS buckets, columnar. */
  history(minutes: number, now: number = Date.now()): HistoryResponse {
    const mins = Math.max(1, Math.min(1440, Math.floor(minutes)));
    const step = Math.max(1000, Math.ceil((mins * 60) / MAX_POINTS) * 1000);
    const from = now - mins * 60_000;
    const rows = this.db.prepare(
      `SELECT (at / ?) * ? AS t,
              avg(m) m, avg(b1i) b1i, avg(b1o) b1o, avg(b2i) b2i, avg(b2o) b2o, avg(b3i) b3i, avg(b3o) b3o,
              avg(loss1) loss1, avg(loss2) loss2, avg(loss3) loss3,
              max(leak) leak, avg(ntu) ntu, avg(ppm) ppm
       FROM telemetry WHERE at >= ? GROUP BY t ORDER BY t`,
    ).all(step, step, from) as Record<HistoryCol | "t", number | null>[];
    const out: HistoryResponse = {
      step, t: [], m: [], b1i: [], b1o: [], b2i: [], b2o: [], b3i: [], b3o: [],
      loss1: [], loss2: [], loss3: [], leak: [], ntu: [], ppm: [],
    };
    for (const r of rows) {
      out.t.push(Number(r.t ?? 0));
      for (const c of HISTORY_COLS) {
        const v = r[c];
        out[c].push(v === null ? 0 : c === "leak" ? Math.round(Number(v)) : Math.round(Number(v) * 100) / 100);
      }
    }
    return out;
  }

  rowCount(): number {
    const row = this.db.prepare("SELECT count(*) AS n FROM telemetry").get() as { n: number };
    return row.n;
  }

  close(): void {
    try { this.db.close(); } catch (err) { logError("DB", "close failed", err); }
  }
}
