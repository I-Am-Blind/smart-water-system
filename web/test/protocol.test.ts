/** Golden samples in docs/samples must validate with the shared schemas. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BrandSchema, CmdBodySchema, DeviceToServerSchema, ViewerToServerSchema } from "@proto/schema";
import type { ServerToViewer } from "@proto/types";
import { applyMessage, getState } from "../src/lib/store";

const dir = path.resolve(import.meta.dirname, "..", "..", "docs", "samples");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const load = (f: string): unknown => JSON.parse(readFileSync(path.join(dir, f), "utf8"));

test("samples directory has the expected fixtures", () => {
  for (const name of ["hello.json", "tel.json", "evt_leak.json", "cmd_device_valve.json", "cmd_viewer_valve.json", "ack_device_ok.json", "state.json", "brand.json"]) {
    assert.ok(files.includes(name), `missing ${name}`);
  }
});

test("device -> server samples validate", () => {
  for (const f of files.filter((n) => /^(hello|tel|evt_|ack_device)/.test(n))) {
    const r = DeviceToServerSchema.safeParse(load(f));
    assert.ok(r.success, `${f}: ${r.success ? "" : JSON.stringify(r.error.issues)}`);
  }
});

test("viewer -> server samples validate", () => {
  for (const f of files.filter((n) => n.startsWith("cmd_viewer"))) {
    const r = ViewerToServerSchema.safeParse(load(f));
    assert.ok(r.success, `${f}: ${r.success ? "" : JSON.stringify(r.error.issues)}`);
  }
});

test("device cmd bodies validate as CmdBody", () => {
  for (const f of files.filter((n) => n.startsWith("cmd_device"))) {
    const { t: _t, id: _id, ...body } = load(f) as { t: string; id: number };
    void _t; void _id;
    const r = CmdBodySchema.safeParse(body);
    assert.ok(r.success, `${f}: ${r.success ? "" : JSON.stringify(r.error.issues)}`);
  }
});

test("brand samples and branding.json validate", () => {
  const brandMsg = load("brand.json") as { brand: unknown };
  assert.ok(BrandSchema.safeParse(brandMsg.brand).success);
  const state = load("state.json") as { brand: unknown };
  assert.ok(BrandSchema.safeParse(state.brand).success);
  const file = JSON.parse(readFileSync(path.resolve(dir, "..", "..", "branding.json"), "utf8")) as unknown;
  const r = BrandSchema.safeParse(file);
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues));
});

test("invalid telemetry is rejected", () => {
  const tel = load("tel.json") as { f: number[] };
  assert.equal(DeviceToServerSchema.safeParse({ ...tel, f: tel.f.slice(0, 6) }).success, false);
  assert.equal(DeviceToServerSchema.safeParse({ ...tel, leak: [0, 4, 0] }).success, false);
});

test("browser store applies server messages", () => {
  applyMessage(load("state.json") as ServerToViewer);
  assert.equal(getState().online, true);
  assert.equal(getState().events.length, 2);
  applyMessage(load("device.json") as ServerToViewer);
  assert.equal(getState().online, false);
  applyMessage({ ...(load("evt_leak.json") as object), at: Date.now() } as ServerToViewer);
  assert.equal(getState().events.length, 3);
  applyMessage(load("brand.json") as ServerToViewer);
  assert.equal(getState().brand.name, "Cascade");
  applyMessage(load("ack_viewer_offline.json") as ServerToViewer);
  assert.equal(getState().lastError, "device_offline");
  applyMessage(load("ack_viewer_ok.json") as ServerToViewer);
  assert.equal(getState().lastError, null);
});
