# Wire protocol v1

Single source of truth for how the ESP32 rig, the server, the web UI and the mobile app talk.
Machine-readable twins: `packages/protocol/types.ts` (types, constants), `packages/protocol/schema.ts` (zod validators, server only), `docs/samples/*.json` (golden messages used by tests).
Owned by the orchestrator. If an implementation needs a change, report it; do not change field names locally.

## 0. The rig this describes

Two lanes, one working IN/OUT flow pair, no master sensor.

| | branch 1 | branch 2 |
|---|---|---|
| Solenoid valve | yes (relay V1) | yes (relay V2) |
| Flow sensing | IN + OUT (YF-S401) | **none** |
| Leak detection | yes | no |
| Role | monitored lane | backup lane, opened automatically on failover |

A branch with no flow sensing reports `loss` and `leak` as `0`. **Those zeros are not measurements** — viewers must render them as "no data" (a dash), and `hello.mon` says which branches are sensed. There is no manifold/master check: the sensor it needed does not exist on this rig.

## 1. Transport

| | |
|---|---|
| Endpoint | WebSocket, path `/ws` on the server (laptop: `ws://<laptop-ip>:3000/ws` or `ws://<laptop-name>.local:3000/ws`; cloud: `wss://<host>/ws`) |
| Framing | JSON text, exactly one message per frame, max 64 KB. Every message has a string `t` discriminator. Unknown `t` is ignored, never an error. |
| Device role | The ESP32 (or `scripts/fake-device.ts`) connects with no query string and MUST send `hello` within 5 s, else the server closes with code 4001. If a second device connects, the older socket is closed with 4000 "replaced". |
| Viewer role | Browsers and the mobile app connect to `/ws?role=viewer`. The server immediately sends `state`. Any number of viewers. |
| Liveness | Server sends WS ping every 10 s and terminates sockets that do not pong. Device library heartbeat: ping 15 s, pong timeout 3 s, 2 misses. Device is **online** iff its socket is open AND a `tel` arrived within 5 s. |
| Time | Device messages carry `ms` = device `millis()`. The server stamps every relayed device message with `at` = server epoch ms. Viewers use `at`, never `ms`. |

Both ends must be on the same network with client isolation **off**. The firmware joins the configured Wi-Fi and, if it cannot, falls back to its own access point (`<deviceName>-rig`) and dials `ws://192.168.4.2:3000/ws` — the first DHCP lease it hands out, i.e. the laptop. A `.local` host in the server URL is resolved over mDNS, which is the way to survive a drifting laptop IP.

### Array conventions

- Sensor arrays `f` and `p` have 2 entries in this order: `[b1i, b1o]` = branch 1 IN, branch 1 OUT.
- Branch arrays `loss`, `leak`, `v` have 2 entries, index 0..1 = branch 1..2.
- A scalar branch field `b` is 1 or 2.
- YF-S401: pulses per second / 98 = L/min.

## 2. Device → server

### hello (once per connection, first message)
```json
{"t":"hello","proto":1,"id":"rig-7a3f21","fw":"2.0.0","ip":"192.168.0.42","rssi":-58,"rst":"POWERON","mon":[1,0],"sim":false}
```
`id` = `"rig-"` + last 6 hex digits of the MAC (`"sim"` for the fake device). `rst` = reset reason text (POWERON, SW, PANIC, INT_WDT, TASK_WDT, WDT, DEEPSLEEP, BROWNOUT, SDIO, UNKNOWN). `mon[i]` = 1 when branch i+1 has flow sensing.

### tel (1 Hz, latest snapshot only, never a backlog)
```json
{"t":"tel","ms":123456,"seq":120,
 "f":[1.21,0.58],"p":[1199870,600120],
 "loss":[52.1,0],"leak":[3,0],"v":[0,1],"pump":1,
 "turb":{"mv":2410,"ntu":14},"tds":{"mv":420,"ppm":186},
 "rssi":-58,"up":123,"heap":215000,"sim":false}
```
| field | type | meaning |
|---|---|---|
| `ms` | uint32 | device millis() at sample time |
| `seq` | uint32 | increments per tel |
| `f` | number[2] | L/min, 2 dp |
| `p` | uint32[2] | cumulative raw pulses (uncalibrated) |
| `loss` | number[2] | `(in-out)/in*100` over the 3 s window, 1 dp; `0` when the check is gated (valve closed, settling, IN < 0.5 L/min) and always `0` for an unsensed branch |
| `leak` | int[2] | 0 ok, 1 warn, 2 drip (latched, valve closed), 3 burst (latched, valve closed); always 0 for an unsensed branch |
| `v` | 0/1[2] | valve relay state, 1 = open (relay energised) |
| `pump` | 0/1 | pump relay state |
| `turb.mv`, `turb.ntu` | int | millivolts at the ADC pin; NTU estimate 0..3000 |
| `tds.mv`, `tds.ppm` | int | millivolts at the ADC pin; ppm at 25 C |
| `rssi` | int | dBm |
| `up` | uint32 | seconds since boot |
| `heap` | uint32 | free heap bytes |
| `sim` | bool | sender is the fake device, not real hardware |

### evt (on state change)
```json
{"t":"evt","ms":123456,"ev":"leak","b":1,"kind":"burst","loss":62.5,"src":"leak"}
{"t":"evt","ms":123999,"ev":"valve","b":1,"on":0,"src":"leak"}
{"t":"evt","ms":124300,"ev":"valve","b":2,"on":1,"src":"leak","reason":"failover"}
{"t":"evt","ms":130000,"ev":"pump","on":0,"src":"wd","reason":"max_on"}
{"t":"evt","ms":150000,"ev":"leak_clear","src":"serial"}
{"t":"evt","ms":160000,"ev":"all_off","src":"ws"}
{"t":"evt","ms":40,"ev":"boot","src":"boot"}
```
`ev` ∈ `boot | leak | leak_clear | valve | pump | all_off`. `src` ∈ `serial | ws | leak | wd | interlock | boot` (who caused it). `reason` ∈ `max_on | all_closed | failover` (why the watchdog/interlock/leak logic acted). `kind` ∈ `drip | burst`. `on` is the NEW state for valve / pump.

### ack (reply to every cmd, within 3 s)
```json
{"t":"ack","id":17,"ok":true,"ms":123500}
{"t":"ack","id":17,"ok":false,"err":"latched"}
```
`err` ∈ `latched` (branch leak latched, valve on refused until reset_leak) | `bad_branch` | `no_open_valve` (pump refused, all valves closed) | `unknown_act` | `bad_json`. Every successful ack carries the device `ms`.

## 3. Server → device

### cmd
```json
{"t":"cmd","id":17,"act":"valve","b":1,"on":true,"dur":120}
{"t":"cmd","id":18,"act":"pump","on":true,"dur":120}
{"t":"cmd","id":19,"act":"all_off"}
{"t":"cmd","id":20,"act":"reset_leak"}
{"t":"cmd","id":21,"act":"ping"}
```
`id` uint32 assigned by the server, echoed in the ack. `act` ∈ `valve | pump | all_off | reset_leak | ping`. `b` required for valve (1 or 2). `dur` seconds the relay may stay on; absent/0 = firmware default (valve 600 s cap, pump 20 s default / 300 s cap).

### welcome (once after hello; device may ignore)
```json
{"t":"welcome","now":1725900000000}
```

## 4. Viewer → server

### cmd
```json
{"t":"cmd","cid":"v-1725900000-1","act":"valve","b":1,"on":false}
{"t":"cmd","cid":"v-1725900000-2","act":"pump","on":true,"dur":120}
```
Same body as the device cmd but with a caller-chosen string `cid` instead of `id`. The server assigns the integer `id`, forwards to the device, and returns the ack by `cid`. The UI always sends `dur:120` when turning the pump on.

## 5. Server → viewer

### state (first message after connect; full snapshot)
```json
{"t":"state","now":1725900001000,"online":true,"lastSeen":1725900000900,
 "info":{"t":"hello", "...":"..."},
 "tel":{"t":"tel","at":1725900000900, "...":"..."},
 "events":[{"t":"evt","at":1725900000500, "...":"..."}],
 "brand":{"name":"Cascade","shortName":"Cascade","tagline":"...","deviceName":"rig","team":"","school":"","branches":["Monitored line","Backup line"],"colors":{"bg":"#0a1224","accent":"#22d3ee","ok":"#34d399","warn":"#fbbf24","danger":"#f43f5e"},"showQr":true},
 "serverUrl":"http://192.168.0.8:3000"}
```
`tel`/`info` are `null` and `lastSeen` is `null` if no device has ever connected (the server rehydrates the last known values from SQLite on restart). `events` newest first, ≤ 50. `brand` = `branding.json`. `serverUrl` = this server's LAN URL (for the QR code and the mobile settings default).

### tel / evt (relayed, stamped)
Identical to the device messages plus `"at": <server epoch ms>`. `tel` may be dropped for a viewer whose socket buffer exceeds 256 KB; `evt`, `device`, `ack`, `brand` are never dropped.

### device (only on transitions)
```json
{"t":"device","online":false,"lastSeen":1725899990000,"info":{"t":"hello","...":"..."}}
```

### ack
```json
{"t":"ack","cid":"v-1725900000-1","ok":true}
{"t":"ack","cid":"v-1725900000-2","ok":false,"err":"device_offline"}
```
`err` = any device error, or `device_offline` (immediate), `timeout` (no device ack within 3 s), `bad_cmd` (failed validation / duplicate cid in flight).

### brand (when branding.json changes on disk)
```json
{"t":"brand","brand":{"...":"..."}}
```

### err (invalid inbound message; informational)
```json
{"t":"err","msg":"invalid tel: f must have 2 items"}
```

## 6. HTTP (same server, same port)

| Method / path | Response |
|---|---|
| `GET /api/status` | `state` fields (without `t`) plus `viewers` (count) and `rows` (telemetry rows stored) |
| `GET /api/history?minutes=30` | columnar `{step, t[], b1i[], b1o[], loss1[], leak[], ntu[], ppm[]}`; minutes clamped 1..1440; ≤ 600 buckets (`step` ms); `leak` is the highest level of the monitored branch in the bucket |
| `GET /api/events?limit=100&before=<at>` | `Stamped<RigEvent>[]` newest first |
| `GET /api/branding` | `Brand` |
| `GET /api/qr.svg` | SVG QR code of `serverUrl` |
| `POST /api/cmd` body `{act,b?,on?,dur?}` | `{ok, err?}`; HTTP 503 when device offline, 504 on ack timeout, 400 on bad body |

The firmware serves no HTTP of its own: the serial console is the local fallback.

## 7. Rules

1. Boot never energises a relay. `all_off` = pump off + all valves closed, from any source, always accepted.
2. Pump: refuses to start when all valves are closed (`no_open_valve`); stops automatically when the last open valve closes (`interlock`/`all_closed`); default on-time 20 s, `dur` up to 300 s.
3. Valves: stay open until closed; hard cap 600 s (`wd`/`max_on`).
4. Leak latched (level 2/3) on the monitored branch: the device closes that branch's valve (`src:"leak"`), then after a 300 ms break-before-make pause opens the backup branch (`evt valve b:2 on:1 reason:"failover"`) so water keeps moving. `valve on` for the latched branch is refused with `latched` until `reset_leak`. `reset_leak` clears latches only; it does not reopen or close anything.
5. The device keeps detecting leaks and enforcing all of the above with no Wi-Fi and no server.
6. Telemetry is 1 Hz. The server tolerates 0.5–2 Hz. Only the latest snapshot is ever sent; nothing is queued while offline.

## 8. Web store API (web/src/lib/store.ts; the dashboard and the 3D twin both build on this)

```ts
export interface RigState {
  conn: "connecting" | "open" | "closed";   // this browser's socket to the server
  online: boolean;                            // device online (from state/device msgs)
  lastSeen: number | null;
  info: Hello | null;
  tel: Stamped<Telemetry> | null;
  events: Stamped<RigEvent>[];                // newest first, <= 50
  brand: Brand;
  serverUrl: string;
  pending: Record<string, ViewerCmd>;         // cmds awaiting ack, keyed by cid
}
export function useRig<T>(sel: (s: RigState) => T): T;   // useSyncExternalStore; selectors must return stable slices or primitives
export function subscribe(fn: () => void): () => void;
export function getState(): RigState;
export function sendCmd(cmd: Omit<ViewerCmd, "t" | "cid">): string;   // returns cid
// web/src/lib/ws-client.ts
export function start(): void;   // idempotent; connects to `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?role=viewer`
```
The mobile app (`mobile/lib/store.ts`) exposes the same `RigState` shape and `useRig` signature.
