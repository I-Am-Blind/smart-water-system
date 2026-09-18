# Cascade – smart water leak-detection rig

Science-fair rig: an Arduino Uno watches an IN/OUT pair of flow sensors on one branch and detects leaks on the board itself. In automatic mode it closes that branch's solenoid and opens the backup branch; in manual mode it reports the leak and leaves the valves to you. It talks to the laptop over USB, where one small server shows a live 3D twin of the rig and a control dashboard, and serves the phone app (Expo).

The rig has **two branches and one working pair of meters**: branch 1 is monitored, branch 2 is a solenoid only. See `docs/PROTOCOL.md` §0.

The product name, colours and branch names live in `branding.json` and can be changed at any time; the server and apps read it live.

## Layout

| Path | What | Docs |
|---|---|---|
| `start.cmd` | **Windows: double-click to install and run everything** (calls `scripts/start.mjs`). | below |
| `firmware/uno_usb_rig/` | The firmware the rig runs: Arduino Uno, leak detection, automatic/manual valves, protocol over USB. | `firmware/README.md` |
| `firmware/verified_full_test/` | The original Uno bench sketch the leak rule comes from. | `firmware/README.md` |
| `firmware/rig_firmware/`, `firmware/rig_diagnostic_v1/` | Retired ESP32-S3 (Wi-Fi) firmware and its bring-up sketch. | `firmware/README.md`, `docs/FLASHING.md` |
| `web/` | Next.js server + web UI, one Node process: reads the Uno over USB, HTTP, WebSocket on `/ws`, SQLite history. | `web/README.md` |
| `mobile/` | Expo (React Native) app: live view and controls. Runs in Expo Go from a QR code. | `mobile/README.md` |
| `docs/PROTOCOL.md` | The wire contract every part speaks. | |
| `docs/DESIGN.md` | UI design brief and tokens. | |
| `packages/protocol/` | TypeScript types and zod schemas for the contract. | |
| `branding.json` | Names and colours (schema in `branding.schema.json`). | |

## Windows laptop (the fair)

Install once:

1. **Node.js 22 LTS** from https://nodejs.org/en/download. Pick version 22, not 24, and the Windows Installer (.msi); the default options are fine.
2. **This folder**, somewhere with a short path such as `C:\cascade` (GitHub: Code → Download ZIP, then extract).
3. **Arduino IDE**, only to upload `firmware/uno_usb_rig/uno_usb_rig.ino` to the Uno once (Board: Arduino Uno). Any computer will do.
4. Only for Uno clones with a CH340 USB chip: if the board does not show up under Device Manager → Ports (COM & LPT), install the CH340 driver from WCH.
5. On each phone: **Expo Go** from the Play Store / App Store. Or skip the app and use the phone's browser.

Every time:

1. Plug the Uno into the laptop. Close the Arduino IDE: its Serial Monitor would hold the port.
2. Put the laptop and the phones on the same Wi-Fi, one that lets devices see each other (a phone hotspot works).
3. Double-click **`start.cmd`**. The first run downloads and builds everything (5–10 minutes, needs internet); later runs start in under a minute.
4. When Windows Firewall asks about Node.js, tick **Private networks** (and **Public** if the venue Wi-Fi is marked public), then Allow.
5. The dashboard opens in the browser. Phones: scan the QR code in the window with Expo Go (Android) or the Camera app (iPhone), or open the "Dashboard on phones" address in any browser.
6. To stop, close the window or press Ctrl+C.

When the Uno is talking, the dashboard header says "Rig online". If the window keeps printing `no Arduino found`, try another USB cable (some only charge) and check Device Manager. On macOS or Linux the same launcher runs with `node scripts/start.mjs`.

No hardware? Run the simulator in a second terminal: `cd web` then `corepack pnpm fake -- --leak` (keys: l leak, a auto/manual, 1/2 valves, o offline 15 s).

## Fair-day checklist

1. Uno plugged in; laptop and phones on the same Wi-Fi; laptop set never to sleep while plugged in (Settings → System → Power).
2. `start.cmd` running, dashboard open full screen, header says "Rig online".
3. Water on. In **Automatic** mode (the default) the monitored branch is already open.
4. Demo a leak: open the tap on the monitored branch's leak segment. Within about 3 seconds the twin turns that branch red, its valve closes, the backup branch opens so water keeps moving, and the event log explains what happened. "Clear leak" resets it and goes back to the monitored branch.
5. Switch the Branches card to **Manual** to show that leaks are still detected and shown, while you open and close the valves yourself.

## Hosting elsewhere

The Uno is on USB, so the server has to run on the laptop it is plugged into. `render.yaml` (Render's free tier) still deploys the dashboard, but with no rig attached.

## Verification status

- `firmware/uno_usb_rig` compiles with zero warnings for `arduino:avr:uno`. Its logic and the USB link were tested end to end on a Mac by compiling the sketch for the host against simulated flow pulses and feeding the server through a virtual serial port: readings reach viewers, every command is acked, automatic failover, manual mode, reset, unplug/replug. It has not yet run on the physical rig.
- `pnpm test` validates every golden message in `docs/samples/` against the schemas; `pnpm smoke` runs an end-to-end device → server → viewer round trip against the simulator.
