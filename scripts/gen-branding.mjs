#!/usr/bin/env node
// Generates firmware/rig_firmware/branding.h from branding.json.
// The firmware cannot read JSON at runtime, so names are baked in at compile time.
// Run:  node scripts/gen-branding.mjs   (also wired as `pnpm -C web brand`)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "branding.json");
const out = join(root, "firmware", "rig_firmware", "branding.h");

const b = JSON.parse(readFileSync(src, "utf8"));

// Minimal validation (mirrors branding.schema.json for the fields firmware uses).
const fail = (m) => { console.error(`gen-branding: ${m}`); process.exit(1); };
if (typeof b.name !== "string" || !b.name) fail("name is required");
if (typeof b.shortName !== "string" || !b.shortName) fail("shortName is required");
if (!/^[a-z0-9-]{1,24}$/.test(b.deviceName ?? "")) fail("deviceName must match ^[a-z0-9-]{1,24}$");
if (!Array.isArray(b.branches) || b.branches.length !== 2) fail("branches must have exactly 2 entries");

// Firmware logs are ASCII-only: strip anything outside printable ASCII, escape for a C string literal.
const cstr = (s) => String(s).replace(/[^\x20-\x7e]/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const h = `// GENERATED FILE - do not edit. Source: branding.json  (node scripts/gen-branding.mjs)
#pragma once
#define BRAND_NAME        "${cstr(b.name)}"
#define BRAND_SHORT_NAME  "${cstr(b.shortName)}"
#define BRAND_DEVICE_NAME "${cstr(b.deviceName)}"
#define BRAND_BRANCH_1    "${cstr(b.branches[0])}"
#define BRAND_BRANCH_2    "${cstr(b.branches[1])}"
`;
writeFileSync(out, h);
console.log(`gen-branding: wrote ${out}`);
