/**
 * zod 4 validators for the wire contract. Server-side only (keeps zod out of client bundles).
 * Types are derived from ./types.ts; keep the two files in sync.
 */
import { z } from "zod";
import type {
  Brand, Hello, Telemetry, RigEvent, DeviceAck, ViewerCmd, CmdBody, DeviceToServer, ViewerToServer,
} from "./types";

const hex = /^#[0-9a-fA-F]{6}$/;
const onOff = z.union([z.literal(0), z.literal(1)]);
const leakLevel = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const branch = z.union([z.literal(1), z.literal(2)]);

export const BrandSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1).max(40),
  shortName: z.string().min(1).max(16),
  tagline: z.string().max(120),
  deviceName: z.string().regex(/^[a-z0-9-]{1,24}$/),
  team: z.string().max(80).default(""),
  school: z.string().max(80).default(""),
  branches: z.tuple([z.string().min(1).max(24), z.string().min(1).max(24)]),
  colors: z.object({
    bg: z.string().regex(hex), accent: z.string().regex(hex), ok: z.string().regex(hex),
    warn: z.string().regex(hex), danger: z.string().regex(hex),
  }),
  showQr: z.boolean(),
});

export const HelloSchema = z.object({
  t: z.literal("hello"),
  proto: z.literal(1),
  id: z.string().min(1).max(32),
  fw: z.string().max(32),
  ip: z.string().max(45),
  rssi: z.number(),
  rst: z.string().max(16),
  mon: z.array(onOff).length(2),
  sim: z.boolean(),
});

export const TelemetrySchema = z.object({
  t: z.literal("tel"),
  ms: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  f: z.array(z.number().nonnegative()).length(2),
  p: z.array(z.number().int().nonnegative()).length(2),
  loss: z.array(z.number()).length(2),
  leak: z.array(leakLevel).length(2),
  v: z.array(onOff).length(2),
  pump: onOff,
  auto: onOff,
  turb: z.object({ mv: z.number(), ntu: z.number() }),
  tds: z.object({ mv: z.number(), ppm: z.number() }),
  rssi: z.number(),
  up: z.number().nonnegative(),
  heap: z.number().nonnegative(),
  sim: z.boolean(),
});

export const RigEventSchema = z.object({
  t: z.literal("evt"),
  ms: z.number().int().nonnegative(),
  ev: z.enum(["boot", "leak", "leak_clear", "valve", "pump", "all_off", "mode"]),
  b: branch.optional(),
  kind: z.enum(["drip", "burst"]).optional(),
  loss: z.number().optional(),
  on: onOff.optional(),
  src: z.enum(["serial", "ws", "leak", "wd", "interlock", "boot"]),
  reason: z.enum(["max_on", "all_closed", "failover"]).optional(),
});

export const DeviceAckSchema = z.object({
  t: z.literal("ack"),
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  err: z.enum(["latched", "bad_branch", "no_open_valve", "unknown_act", "bad_json", "auto_mode"]).optional(),
  ms: z.number().optional(),
});

const cmdAct = z.enum(["valve", "pump", "all_off", "reset_leak", "ping", "auto"]);

export const CmdBodySchema = z.object({
  act: cmdAct,
  b: branch.optional(),
  on: z.boolean().optional(),
  dur: z.number().int().min(0).max(600).optional(),
}).refine((c) => c.act !== "valve" || c.b !== undefined, { message: "valve needs b" });

export const ViewerCmdSchema = z.object({
  t: z.literal("cmd"),
  cid: z.string().min(1).max(64),
  act: cmdAct,
  b: branch.optional(),
  on: z.boolean().optional(),
  dur: z.number().int().min(0).max(600).optional(),
});

export const DeviceToServerSchema = z.discriminatedUnion("t", [
  HelloSchema, TelemetrySchema, RigEventSchema, DeviceAckSchema,
]);
export const ViewerToServerSchema = z.discriminatedUnion("t", [ViewerCmdSchema]);

// Compile-time check that the schemas produce the declared types.
type Assert<T extends true> = T;
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type _checks = [
  Assert<Eq<z.infer<typeof HelloSchema>, Hello>>,
  Assert<Eq<z.infer<typeof TelemetrySchema>, Telemetry>>,
  Assert<Eq<z.infer<typeof RigEventSchema>, RigEvent>>,
  Assert<Eq<z.infer<typeof DeviceAckSchema>, DeviceAck>>,
  Assert<Eq<z.infer<typeof ViewerCmdSchema>, ViewerCmd>>,
  Assert<Eq<z.infer<typeof BrandSchema>, Brand & { $schema?: string }>>,
  Assert<Eq<z.infer<typeof DeviceToServerSchema>, DeviceToServer>>,
  Assert<Eq<z.infer<typeof ViewerToServerSchema>, ViewerToServer>>,
  Assert<Eq<z.infer<typeof CmdBodySchema>, CmdBody>>,
];
