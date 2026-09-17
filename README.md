# Cascade – smart water leak-detection rig

Science-fair rig: an ESP32-S3 watches an IN/OUT pair of flow sensors on one branch, detects leaks on the device itself, closes that branch's solenoid and opens the backup branch, and streams everything over one WebSocket to a small server that shows a live 3D twin of the rig and a control dashboard. A phone app (Expo) and a QR code for visitors round it out.

The rig has **two branches and one working pair of meters**: branch 1 is monitored, branch 2 is a solenoid only. See `docs/PROTOCOL.md` §0.

The product name, colours and branch names live in `branding.json` and can be changed at any time. After editing it run `node scripts/gen-branding.mjs` so the firmware picks up the new names (the server and apps read it live).

## Layout

| Path | What | Docs |
|---|---|---|
| `firmware/rig_diagnostic_v1/` | Hardware bring-up sketch (single file). Flash this first. | `docs/FLASHING.md` |
| `firmware/verified_full_test/` | The Arduino Uno sketch whose behaviour the production firmware reproduces. | `firmware/README.md` |
| `firmware/rig_firmware/` | Production firmware, one file: leak detection, failover, safety interlocks, Wi-Fi + WebSocket client, serial console. | `firmware/README.md` |
| `web/` | Next.js server + web UI, one Node process: HTTP, WebSocket on `/ws`, SQLite history. | `web/README.md` |
| `mobile/` | Expo (React Native) app: live view and controls. Runs in Expo Go from a QR code. | `mobile/README.md` |
| `docs/PROTOCOL.md` | The wire contract every part speaks. | |
| `docs/DESIGN.md` | UI design brief and tokens. | |
| `packages/protocol/` | TypeScript types and zod schemas for the contract. | |
| `branding.json` | Names and colours (schema in `branding.schema.json`). | |

## Quick start on the laptop

```bash
cd web
pnpm install
pnpm build
pnpm start            # http://localhost:3000  (WebSocket on ws://<this-ip>:3000/ws)
```
macOS will ask whether `node` may accept incoming connections: allow it. Run `caffeinate -dims` in another terminal during a demo so the laptop never sleeps.

No hardware yet? In a second terminal:
```bash
cd web
pnpm fake -- --leak   # simulated rig, leaking from the start; keys: l leak, 1/2 valves, p pump, o offline 15 s
```

Point the ESP32 at the laptop once, over the Arduino IDE serial monitor (115200 baud):
```
ssid=YourWifiName
pass=YourWifiPassword
server=ws://192.168.0.3:3000/ws      # the laptop's LAN IP; `ipconfig getifaddr en0` on macOS
show
```
The firmware keeps these in flash and reconnects on its own whenever that Wi-Fi is present. If it cannot join after 30 s it starts its own access point (SSID = the device id, password `cascade2026`) and expects the laptop to join it and serve on `ws://192.168.4.2:3000/ws` — so a demo works with no router at all. Leak detection and all safety rules run on the device with or without the server.

Phones: open the dashboard URL shown in "Open on phone" (any browser, no install), or run the Expo app from `mobile/` and scan its QR code with Expo Go.

## Fair-day checklist

1. Laptop, ESP32 and phones on the same Wi-Fi or hotspot (test that clients can reach each other; some hotspots isolate them), or let the rig make its own AP and join that.
2. `pnpm start` running, `caffeinate -dims` running, dashboard open in a full-screen browser window.
3. Power the rig: the dashboard header shows "Rig online" within a few seconds. If not, open the serial monitor and type `wifi` then `show`.
4. Water off, press "All off", then open the monitored branch's valve and "Run pump for 2 minutes" to prime it.
5. To demo a leak: open the tap on the monitored branch's leak segment; within about 5 seconds the twin turns that branch red, its valve closes on its own, the backup branch opens so water keeps moving, and the event log explains what happened. "Clear leak" resets it.

## Hosting elsewhere

The same `web/` process runs unchanged on Render's free tier (`render.yaml` at the repo root); the device must then use `wss://<your-app>.onrender.com/ws`. Vercel cannot host it because the device connection must stay open for hours. History in SQLite resets whenever a free Render instance restarts, which is fine for a demo.

## Verification status

- The ESP32 sketches compile with zero warnings on Arduino-ESP32 core 3.3.0 (`arduino-cli … --warnings all`). The leak/failover behaviour they implement was verified on hardware with `firmware/verified_full_test/` on an Arduino Uno; `rig_firmware` itself has not been flashed to the ESP32 in this repo's history yet, so follow `docs/FLASHING.md` and the bench test in `firmware/README.md`.
- `pnpm test` validates every golden message in `docs/samples/` against the schemas; `pnpm smoke` runs an end-to-end device → server → viewer round trip against the simulator.
