# Firmware

Two sketches live here:

| Folder | Purpose | When |
|---|---|---|
| `rig_diagnostic_v1/` | Single-file bring-up test. Checks wiring, PSRAM, ADC, Wi-Fi radio; lets you click relays by hand. | First, on a new board or after rewiring. See `docs/FLASHING.md`. |
| `rig_firmware/` | Production firmware: leak detection, relay safety, WebSocket telemetry to the server. | After the diagnostic passes. This document. |

## 1. Arduino IDE settings (Tools menu)

| Setting | Value |
|---|---|
| Board | **ESP32S3 Dev Module** (esp32 core 3.3.x) |
| USB CDC On Boot | **Enabled** |
| USB Mode | Hardware CDC and JTAG |
| Flash Mode | **QIO 80MHz** |
| Flash Size | **16MB (128Mb)** |
| PSRAM | **OPI PSRAM** |
| Partition Scheme | **Huge APP (3MB No OTA/1MB SPIFFS)** ← different from the diagnostic |
| CPU Frequency | 240MHz |
| Upload Speed | 921600 (drop to 115200 if uploads fail) |

Libraries (Sketch → Include Library → Manage Libraries):

| Library Manager name | Author | Version |
|---|---|---|
| **ArduinoJson** | Benoit Blanchon | 7.3.x |
| **WebSockets** | Markus Sattler | 2.7.x (2.6.1 or newer) |

Command-line equivalent:
```
CLI="/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"
"$CLI" lib install "ArduinoJson@7.3.0" "WebSockets@2.7.2"
"$CLI" compile --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashMode=qio,FlashSize=16M,PSRAM=opi,PartitionScheme=huge_app --warnings all firmware/rig_firmware
```
The sketch compiles with zero warnings from its own files (the WebSockets library prints one deprecation warning under `--warnings all`; harmless).

`rig_firmware/branding.h` is generated from `branding.json` by `node scripts/gen-branding.mjs`. Edit the JSON, run the script, rebuild.

## 2. First boot: point it at your Wi-Fi and server

Open the Serial Monitor at **115200** (either USB port works; the log goes to both). You will see:

```
[52][BOOT] Cascade firmware 1.0.0 built Sep  9 2026 12:00:00
[60][BOOT] chip=ESP32-S3 cpu=240MHz flash=16MB psram=8192KB core=3.3.0
[61][RELAY] safe init: V1 V2 V3 PUMP all OFF
[62][FLOW] isr attached x7 glitch=500us window=3s
[63][LEAK] min=0.5L/min warn=12% drip=20%/5s burst=50%/2s manifold=25%/5s
[70][CFG] ssid='' pass=(none) server=ws://192.168.0.3:3000/ws name=rig id=rig-7a3f21
[71][MENU] type 'help' for commands; '!' = all relays off
[80][WIFI] no ssid configured, offline mode (type: ssid=YourNetwork)
```

Type these lines (each followed by Enter). They are saved to flash and applied immediately, no reboot:

```
ssid=YourHotspotName
pass=YourPassword
server=ws://192.168.0.3:3000/ws
```

Replace `192.168.0.3` with the laptop's address (macOS: System Settings → Wi-Fi → Details, or `ipconfig getifaddr en0`). A Bonjour name also works: `server=ws://MacBook-Pro-7.local:3000/ws` (the firmware resolves `.local` names with mDNS). Give the laptop a fixed IP in the hotspot/router settings so this never changes.

Expected log:
```
[..][CFG] saved ssid, applying
[..][WIFI] connecting to 'YourHotspotName'
[..][WIFI] got ip 192.168.0.42 rssi=-55
[..][MDNS] http://rig.local
[..][WS] connecting ws://192.168.0.3:3000/ws
[..][WS] connected 192.168.0.3:3000/ws
[..][WS] tx hello id=rig-7a3f21
```
If the server is not running you will see `[WS] no server at 192.168.0.3:3000, retrying every 2s` every 30 s; the rig keeps working on its own and connects as soon as the server appears. Same for Wi-Fi: it reconnects whenever the SSID shows up.

Cloud server: `server=wss://your-app.onrender.com/ws` (TLS without certificate check).

## 3. Serial commands

| Command | Effect |
|---|---|
| `!` | **Emergency stop.** Every relay off, instantly, no Enter needed. |
| `help` | Command list |
| `show` | Stored settings (password masked) and device id |
| `id` | Device id and firmware version |
| `wifi` | Wi-Fi status, IP, RSSI, WebSocket state |
| `scan` | List nearby networks |
| `ssid=…` `pass=…` `server=…` `name=…` | Save a setting (applied live). `name` is the mDNS hostname. |
| `v1 on [sec]` / `v1 off` (also v2, v3) | Open/close a valve. Open time capped at 600 s. |
| `pump on [sec]` / `pump off` | Pump. Default 20 s, maximum 300 s. Refused when all valves are closed. |
| `off` | All relays off (same as `!`) |
| `reset` | Clear leak latches (valves stay closed until opened again) |
| `stat` | Current L/min, pulse counts, loss %, leak levels, relay states |
| `adc` | Turbidity and TDS readings |
| `tel on` / `tel off` | Print the telemetry JSON every second |
| `cal` / `cal show` / `cal clear` | 10 s sensor calibration (pump on, all valves open, no leak) / show / reset factors |
| `sim on` / `sim off` | Fake flow so the UI can be demoed without water |
| `sim flow 1.5` | Simulated per-branch flow in L/min |
| `sim leak 2 35` | Inject a 35 % loss on branch 2 (drip) |
| `sim burst 1` | Inject an 85 % loss on branch 1 |
| `sim mleak 30` | Inject a 30 % manifold loss |
| `sim clear` | Remove injected leaks |
| `reboot` | Restart |

## 4. How leak detection works (and how to tune it)

Every second the firmware turns pulse counts into L/min (98 pulses/s = 1 L/min) and, per branch, compares the IN and OUT sensors over a 3-second window:

```
loss % = (in - out) / in * 100
```

A branch is only judged when its valve is open, the water has had `LEAK_SETTLE_S` seconds to settle after any valve/pump change, and IN ≥ `LEAK_MIN_FLOW_LPM`. Then:

| Condition | Result |
|---|---|
| loss ≥ 12 % (`LEAK_WARN_PCT`) | level 1 "warn", UI only |
| loss ≥ 20 % for 5 s (`LEAK_DRIP_PCT`, `LEAK_DRIP_CONFIRM_S`) | level 2 "drip": valve closed, latched |
| loss ≥ 50 % for 2 s (`LEAK_BURST_PCT`, `LEAK_BURST_CONFIRM_S`) | level 3 "burst": valve closed, latched |
| loss < 10 % (`LEAK_CLEAR_PCT`) | counters reset (hysteresis band 10–20 % holds them) |
| master − Σ open IN ≥ 25 % of master for 5 s | manifold leak: pump stopped, latched |

Latched means the valve refuses to open (`latched`) until `reset`. Everything is in the `#define` block in `config.h`; each line has a one-line explanation. Typical adjustments:

- Two YF-S401 disagree by up to ~10 % at low flow. If a healthy branch shows "warn", run `cal` once with clean flow, or raise `LEAK_WARN_PCT`.
- Detection too slow for the demo? Lower `LEAK_DRIP_CONFIRM_S` to 3. Too jumpy? Raise `LEAK_WINDOW_S` to 5.
- Very low pump flow (< 0.5 L/min per branch)? Lower `LEAK_MIN_FLOW_LPM`, but expect more noise.

## 5. Relay safety rules built into the firmware

1. All four relays are driven OFF in the first microseconds of `setup()`, before the serial port or Wi-Fi start. Nothing ever energises on boot.
2. Every ON has a maximum on-time: valves 600 s, pump 20 s by default / 300 s maximum per command (`dur`). The web UI asks for 120 s and can re-send.
3. The pump refuses to start with all valves closed and stops when the last valve closes.
4. A leak closes the branch valve; a manifold leak stops the pump.
5. `!` on serial, `all_off` from the server, or `POST /cmd {"act":"all_off"}` switch everything off immediately.

## 6. No-water bench test (16 steps)

Power the board from USB, open the Serial Monitor. Relays click audibly; nothing else is needed.

1. Power on → banner lines from section 2, `[RELAY] safe init: V1 V2 V3 PUMP all OFF`, **no relay clicks**.
2. `show` → settings; `help` → command list.
3. `!` (no Enter) → `[RELAY] ALL OFF src=serial`.
4. `v1 on` → click, `[RELAY] V1 ON src=serial maxOn=600s`. `pump on` → click, `[RELAY] PUMP ON src=serial maxOn=20s`; after 20 s: `[SAFE] PUMP auto-off after 20s`, `[RELAY] PUMP OFF src=wd reason=max_on`. `pump on 30` → `maxOn=30s`.
5. `v1 off` while the pump runs → `[RELAY] V1 OFF src=serial` then `[RELAY] PUMP OFF src=interlock reason=all_closed`. `pump on` with all valves closed → `[CMD] refused: no_open_valve`.
6. Real pulse path: briefly touch a jumper from the F1_IN signal pin (GPIO5) to GND a few times; `stat` shows the b1 pulse count increasing. `adc` prints `turb=… mV ntu=…  tds=… mV ppm=…` (open inputs read noise; GPIO9 to GND gives `tds=0 mV`).
7. `sim on` → `[SIM] on base=1.20 L/min`; `v1 on`, `v2 on`, `v3 on`, `pump on 300`; `tel on` → one JSON line per second with `"f":[3.6,1.2,1.2,…]`, `"loss"` within ±5, `"leak":[0,0,0]`.
8. `sim leak 2 35` → within ~8 s `[LEAK] B2 DRIP loss=35.x% confirmed -> closing V2`, `[RELAY] V2 OFF src=leak`. `v2 on` → `[CMD] refused: latched`. `reset` → `[LEAK] reset src=serial`. `sim clear`, then `v2 on` works.
9. `sim burst 1` → within ~4 s `[LEAK] B1 BURST loss=85.x% confirmed -> closing V1`.
10. `sim mleak 30` → within ~8 s `[LEAK] MANIFOLD loss=30.x% confirmed -> pump OFF`, `[RELAY] PUMP OFF src=leak reason=manifold`. `reset`, `sim clear`.
11. Configure Wi-Fi and server (section 2) with the laptop server running → `[WS] connected`, `[WS] tx hello`. In a browser open `http://rig.local/status` → the telemetry JSON.
12. Stop the laptop server → `[WS] disconnected`, later `[WS] no server at …, retrying every 2s`. Meanwhile `stat` still answers and a running `pump on 20` still auto-offs on time. Restart the server → `[WS] connected` again.
13. From the server UI (or `curl -X POST http://rig.local/cmd -d '{"act":"valve","b":1,"on":true,"dur":60}'`) → `[CMD] valve b=1 on dur=60 src=http`, response `{"ok":true}`; `{"act":"ping"}` → `{"ok":true}`; `{"act":"all_off"}` → all relays off.
14. Unplug USB, power from the bench supply, watch Serial0 (GPIO43 TX / GPIO44 RX) with a USB-UART adapter at 115200: same log, and the server keeps receiving telemetry.
15. Soak: `sim on`, all valves open, `pump on 300` re-issued every few minutes for 10 min. `heap` in the telemetry stays within a few KB; no reboot (the `hello` reset reason stays `POWERON`).
16. `pass=wrong` → `[WIFI] disconnected reason=15` (or 2/201 depending on the router) and a retry every 60 s; leak logic is unaffected (repeat step 8 meanwhile). Restore the correct password.

## 7. Hardware pitfalls

- **Relay module logic level.** Most 4-channel modules expect 5 V logic. A 3.3 V HIGH into a 5 V-powered opto input can leave the relay half-on or chattering. Either power the module's logic (VCC) from 3.3 V with the JD-VCC jumper removed and JD-VCC from 5 V, or drive the inputs through the level shifter's 5 V side.
- **Floating inputs during flashing.** GPIO11–14 float from power-on until `setup()` runs and while the board is in download mode. Add 10 kΩ pull-ups to 3.3 V on the four relay input lines so the relays stay off no matter what.
- **Pump power.** Pump inrush on the same 5 V rail as the ESP32 causes brown-out resets (reset reason `BROWNOUT` in the log). Give the pump its own supply, share only GND.
- **Analog pins.** ADC2 (GPIO11–20) cannot be read while Wi-Fi is on. Turbidity and TDS must stay on GPIO8/9 (ADC1). Readings above ~2.5 V are less accurate; the turbidity NTU number is an estimate.
- **Flow sensor signal level.** The YF-S401 output is 5 V open-collector; the 10k/20k dividers bring it to 3.3 V. Without them the ESP32 input will be damaged over time.
- **Sensor tolerance.** Two flow sensors in series can disagree by ~10 %. Run `cal` once with clean flow; the factors are saved in flash.

## 8. Finding the laptop

The rig connects TO the laptop, so it must know where the laptop is:

- Fixed IP (recommended): reserve the laptop's address in the hotspot/router and set `server=ws://<ip>:3000/ws`.
- mDNS: `server=ws://MacBook-Pro-7.local:3000/ws` (find the name with `scutil --get LocalHostName` on the Mac). Some hotspots block mDNS between clients.
- The laptop must allow incoming connections for Node (macOS asks the first time the server starts).
- Fallback the other way round: with no server at all, `http://rig.local/status` on any phone on the same Wi-Fi shows live numbers.
