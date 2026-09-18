# Firmware

| Folder | Board | Purpose |
|---|---|---|
| `uno_usb_rig/` | Arduino Uno | **What the rig runs now.** Leak detection, automatic/manual valve control, the protocol over USB to the laptop. See "Arduino Uno (current)" below. |
| `rig_diagnostic_v1/` | ESP32-S3 | Single-file bring-up test. Checks wiring, PSRAM, ADC, Wi-Fi radio; lets you click relays by hand. Run it first on a new board or after rewiring. See `docs/FLASHING.md`. |
| `verified_full_test/` | Arduino Uno | The bench sketch that proved the plumbing works: 4 flow sensors, 2 relays, the 300 ms failover. Kept as a reference for the behaviour the production firmware copies. |
| `rig_firmware/` | ESP32-S3 | Retired Wi-Fi firmware — one file. Leak detection, relay safety, WebSocket telemetry. Sections 0–2 below. It predates automatic/manual mode, so the current server rejects its telemetry. |

## Arduino Uno (current)

`uno_usb_rig/uno_usb_rig.ino`, one file, no libraries. Arduino IDE: Board **Arduino Uno**, then Upload.
Close the Serial Monitor afterwards: the laptop server needs the port.

| Pin | Use |
|---|---|
| D5 | Flow IN (bench label F4) |
| D4 | Flow OUT (bench label F3) |
| D9 | Valve 1, monitored/normal path (relay, active low) |
| D8 | Valve 2, backup/alternate path (relay, active low) |
| A0 / A1 | Turbidity / TDS |

D4 and D5 are counted with pin-change interrupts (only D2/D3 support `attachInterrupt` on an Uno).
IN and OUT were assigned from the bench leak log (IN rose, OUT fell); swap the two pin constants if
the dashboard shows them the other way round. The leak rule is the bench sketch's: IN and OUT differ
by 30 pulses or more over 3 s. It boots in automatic mode with valve 1 open.

Bench test without the server: open the Serial Monitor (115200, newline) and watch one `tel` line per
second. Type `?` for `hello`, or a command such as `{"t":"cmd","id":1,"act":"auto","on":false}` then
`{"t":"cmd","id":2,"act":"valve","b":2,"on":true}`.

## 0. What the rig actually is

Two lanes fed by one pump. Four flow sensors were installed; one died, so the lane it belonged to
lost its IN/OUT pair. That lane keeps its solenoid and nothing else.

| Branch | Valve | Flow sensors | Role |
|---|---|---|---|
| 1 "Monitored line" | GPIO11 | IN GPIO16, OUT GPIO17 | Leak detection lives here |
| 2 "Backup line" | GPIO12 | none | Valve on/off only; opened automatically when branch 1 leaks |

A confirmed leak on branch 1 closes V1, waits 300 ms (break before make), opens V2 and latches —
exactly what the Uno sketch does. The pump keeps running, so water still flows through the backup
lane. `reset` (serial) or `reset_leak` (server) clears the latch.

Branch 2 has no sensors, so its `loss` and `leak` numbers on the wire are always 0. Those zeros are
not measurements: the UI renders them as a dash. See `docs/PROTOCOL.md` §0.

Pin map, with the reason each pin was chosen, is the comment block at the top of
`rig_firmware/rig_firmware.ino`. **Confirm `F_IN` / `F_OUT` against your wiring before the first
water test** — everything else is fixed by the board layout, those two are the assumption.

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
The sketch compiles with zero warnings from its own file. Under `--warnings all` the WebSockets
library and the ESP32 core print three deprecation warnings of their own; harmless.

`rig_firmware/branding.h` is generated from `branding.json` by `node scripts/gen-branding.mjs`.
Edit the JSON, run the script, rebuild. It is the only other file in the sketch folder.

## 2. First boot: point it at your Wi-Fi and server

Open the Serial Monitor at **115200** (either USB port works; the log goes to both). You will see:

```
[52][BOOT] Cascade firmware 2.0.0 built Sep 17 2026 16:40:00
[60][BOOT] chip=ESP32-S3 cpu=240MHz flash=16MB psram=8192KB core=3.3.0
[61][BOOT] branch 1 'Monitored line' = monitored (GPIO16 in / GPIO17 out), branch 2 'Backup line' = valve only
[62][RELAY] safe init: V1 V2 PUMP all OFF
[63][FLOW] isr on GPIO16(in) GPIO17(out) glitch=500us window=3s
[64][LEAK] min=0.5L/min delta>=30 pulses warn=12% drip=20%/5s burst=50%/2s failover=on
[70][CFG] ssid='' pass=(none) server=ws://192.168.0.8:3000/ws name=rig id=rig-7a3f21
[71][WIFI] no ssid configured (type: ssid=YourNetwork), starting AP
[72][MENU] type 'help' for commands; '!' = all relays off
```

Type these lines (each followed by Enter). They are saved to flash and applied immediately, no reboot:

```
ssid=YourHotspotName
pass=YourPassword
server=ws://192.168.0.8:3000/ws
```

Replace `192.168.0.8` with the laptop's address (macOS: `ipconfig getifaddr en0`). A Bonjour name
also works: `server=ws://MacBook-Pro-7.local:3000/ws` — the firmware resolves `.local` over mDNS,
which is the fix for a laptop whose DHCP address keeps moving.

Expected log:
```
[..][CFG] saved ssid, applying
[..][WIFI] connecting to 'YourHotspotName'
[..][WIFI] got ip 192.168.0.42 rssi=-55
[..][MDNS] rig.local
[..][WS] connecting ws://192.168.0.8:3000/ws
[..][WS] connected 192.168.0.8:3000/ws
[..][WS] tx hello id=rig-7a3f21
```
If the server is not running you get `[WS] no server at 192.168.0.8:3000, retrying every 2s` every
30 s; the rig keeps detecting leaks on its own and connects as soon as the server appears.

Cloud server: `server=wss://your-app.onrender.com/ws` (TLS without certificate check).

### If there is no usable Wi-Fi: the rig makes its own

30 s after boot without a connection — wrong password, hotspot down, venue Wi-Fi that isolates
clients — the rig starts an access point and dials the laptop across it:

```
[..][WIFI] AP fallback up: ssid='rig-7a3f21' pass='cascade2026' ip=192.168.4.1
[..][WIFI] join it from the laptop, run the server, we dial ws://192.168.4.2:3000/ws
```

Join `rig-7a3f21` from the laptop, start the server, done — no router involved. 192.168.4.2 is the
first address the rig's DHCP hands out, so the laptop gets it as long as it is the only client.
The AP password is `AP_PASS` in the config block. This is one-way: to go back to your Wi-Fi, set
`ssid=` again (which re-applies live) or reboot.

## 3. Serial commands

| Command | Effect |
|---|---|
| `!` | **Emergency stop.** Every relay off, instantly, no Enter needed. |
| `help` | Command list |
| `show` | Stored settings (password masked) and device id |
| `id` | Device id and firmware version |
| `wifi` | Wi-Fi status, IP, RSSI, WebSocket state (or AP details in AP mode) |
| `scan` | List nearby networks |
| `ssid=…` `pass=…` `server=…` `name=…` | Save a setting (applied live). `name` is the mDNS hostname. |
| `v1 on [sec]` / `v1 off` | Branch 1 valve, the monitored lane. Open time capped at 600 s. |
| `v2 on [sec]` / `v2 off` | Branch 2 valve, the backup lane. |
| `pump on [sec]` / `pump off` | Pump. Default 20 s, maximum 300 s. Refused when both valves are closed. |
| `off` | All relays off (same as `!`) |
| `reset` | Clear the leak latch (valves stay as they are) |
| `stat` | L/min, pulse counts, the 3 s window and its pulse delta, loss %, leak level, relay states |
| `adc` | Turbidity and TDS readings |
| `tel on` / `tel off` | Print the telemetry JSON every second |
| `reboot` | Restart |

## 4. How leak detection works (and how to tune it)

Every second the firmware turns pulse counts into L/min (98 pulses/s = 1 L/min) and compares
branch 1's IN and OUT sensors over a 3-second window. Two conditions must both hold, which is what
keeps sensor jitter from crying leak:

```
loss %      = (in - out) / in * 100     >= threshold
pulse delta = pulses_in - pulses_out    >= 30 over the window   (LEAK_MIN_DELTA_PULSES)
```

The pulse floor is the rule proven on the Uno bench rig; 30 pulses per 3 s is about 0.10 L/min.
The branch is judged only while V1 is open, `LEAK_SETTLE_S` seconds have passed since any valve or
pump change, and IN ≥ `LEAK_MIN_FLOW_LPM`. Then:

| Condition | Result |
|---|---|
| loss ≥ 12 % (`LEAK_WARN_PCT`) | level 1 "warn", UI only |
| loss ≥ 20 % for 5 s (`LEAK_DRIP_PCT`, `LEAK_DRIP_CONFIRM_S`) | level 2 "drip": failover, latched |
| loss ≥ 50 % for 2 s (`LEAK_BURST_PCT`, `LEAK_BURST_CONFIRM_S`) | level 3 "burst": failover, latched |
| loss < 10 % (`LEAK_CLEAR_PCT`) | counters reset (the 10–20 % band holds them) |
| OUT exceeds IN by 20 % (`SENSOR_FAULT_PCT`) | logged every 30 s: the two sensors are swapped or one is dead |

Failover = close V1 → wait `FAILOVER_BREAK_MS` (300 ms) → open V2 → latch. Latched means V1 refuses
to open (`latched`) until `reset`. Set `FAILOVER_ON_LEAK` to 0 to just close V1 and stop there.

Everything is in the `#define` block at the top of the sketch; each line has a one-line
explanation. Typical adjustments:

- Two YF-S401 disagree by a few percent. If a healthy branch shows "warn" with steady flow, read
  the two numbers with `stat` and set `FLOW_CAL_OUT` to `in/out` (e.g. 1.040). That replaces the
  old runtime calibration command with one constant you can see.
- Detection too slow for the demo? Lower `LEAK_DRIP_CONFIRM_S` to 3. Too jumpy? Raise
  `LEAK_WINDOW_S` to 5.
- Very low pump flow (< 0.5 L/min)? Lower `LEAK_MIN_FLOW_LPM`, but expect more noise.

## 5. Relay safety rules built into the firmware

1. All three relays are driven OFF in the first microseconds of `setup()`, before the serial port
   or Wi-Fi start. Nothing ever energises on boot.
2. Every ON has a maximum on-time: valves 600 s, pump 20 s by default / 300 s maximum per command
   (`dur`). The web UI asks for 120 s and can re-send.
3. The pump refuses to start with both valves closed and stops when the last valve closes. That
   interlock is suspended for the 300 ms of a failover, so the swap does not kill the pump.
4. A confirmed leak closes branch 1 and opens branch 2.
5. `!` on serial or `all_off` from the server switches everything off immediately. The firmware
   serves no HTTP of its own — the serial console is the local fallback.

## 6. No-water bench test (12 steps)

Power the board from USB, open the Serial Monitor. Relays click audibly.

Steps 7–9 need pulses on the flow inputs. Hand-tapping a jumper cannot reach the 0.5 L/min gate, so
use a square-wave source: a spare Arduino running `tone(3, 100)` (100 Hz ≈ 1.0 L/min), a signal
generator, or a second ESP32 with `ledcAttach(pin, 100, 8); ledcWrite(pin, 128);`. Land it where
the sensor's signal wire lands, i.e. on the input side of the 10k/20k divider, so a 5 V source gets
divided down. Without a source, skip to step 10 and test leaks with real water instead.

1. Power on → the banner from section 2, `[RELAY] safe init: V1 V2 PUMP all OFF`, **no relay clicks**.
2. `show` → settings; `help` → command list.
3. `!` (no Enter) → `[RELAY] ALL OFF src=serial`.
4. `v1 on` → click, `[RELAY] V1 ON src=serial maxOn=600s`. `pump on` → click,
   `[RELAY] PUMP ON src=serial maxOn=20s`; after 20 s `[SAFE] PUMP auto-off after 20s`,
   `[RELAY] PUMP OFF src=wd reason=max_on`. `pump on 30` → `maxOn=30s`.
5. `v1 off` while the pump runs → `[RELAY] V1 OFF src=serial` then
   `[RELAY] PUMP OFF src=interlock reason=all_closed`. `pump on` with both valves closed →
   `[CMD] refused: no_open_valve`.
6. `adc` → `turb=… mV ntu=…  tds=… mV ppm=…` (open inputs read noise; GPIO9 to GND gives `tds=0 mV`).
7. Source on **both** F_IN and F_OUT, `v1 on`, `tel on` → `stat` shows `in` and `out` within a few
   percent, `delta` under 30, `loss` near 0, `leak=0`. This is the healthy case; note the two
   numbers and set `FLOW_CAL_OUT` if they are off by more than ~3 %.
8. Move the source to **F_IN only** (nothing on F_OUT) → IN ≈ 1.0 L/min, OUT 0, loss 100 %. Within
   about 4 s: `[LEAK] B1 BURST loss=100.0% confirmed -> closing V1`, `[RELAY] V1 OFF src=leak`,
   then `[LEAK] failover -> opening V2 (backup lane)` and `[RELAY] V2 ON src=leak reason=failover`.
   The pump keeps running.
9. `v1 on` → `[CMD] refused: latched`. `reset` → `[LEAK] reset src=serial`. Restore the source on
   both inputs, `v1 on` works again.
10. Configure Wi-Fi and server (section 2) with the laptop server running → `[WS] connected`,
    `[WS] tx hello`, then one `tel` per second (the dashboard shows the rig online).
11. Stop the laptop server → `[WS] disconnected`, later `[WS] no server at …, retrying every 2s`.
    Meanwhile `stat` still answers, a running `pump on 20` still auto-offs on time, and step 8
    still latches. Restart the server → `[WS] connected` again. Then from the dashboard: open and
    close each valve, run the pump, press all-off, and clear the latch — the log shows `src=ws`.
12. Unplug USB, power from the bench supply, watch Serial0 (GPIO43 TX / GPIO44 RX) with a USB-UART
    adapter at 115200: same log, and the server keeps receiving telemetry. Leave it running with
    `pump on 300` re-issued for 10 minutes: `heap` in the telemetry stays within a few KB and the
    `hello` reset reason stays `POWERON`.

Also worth doing once: `pass=wrong` → `[WIFI] disconnected reason=…`, then after 30 s the AP
fallback comes up and you can reach the rig by joining `rig-7a3f21`. Restore the real password.

## 7. Hardware pitfalls

- **Relay module logic level.** Most 4-channel modules expect 5 V logic. A 3.3 V HIGH into a 5 V-powered opto input can leave the relay half-on or chattering. Either power the module's logic (VCC) from 3.3 V with the JD-VCC jumper removed and JD-VCC from 5 V, or drive the inputs through the level shifter's 5 V side. This is what kept the relays from working on the ESP32 before the module was swapped.
- **Floating inputs during flashing.** GPIO11–14 float from power-on until `setup()` runs and while the board is in download mode. Add 10 kΩ pull-ups to 3.3 V on the relay input lines so the relays stay off no matter what.
- **Pump power.** Pump inrush on the same 5 V rail as the ESP32 causes brown-out resets (reset reason `BROWNOUT` in the log). Give the pump its own supply, share only GND.
- **Analog pins.** ADC2 (GPIO11–20) cannot be read while Wi-Fi is on. Turbidity and TDS must stay on GPIO8/9 (ADC1). Readings above ~2.5 V are less accurate; the turbidity NTU number is an estimate.
- **Flow sensor signal level.** The YF-S401 output is 5 V open-collector; the 10k/20k dividers bring it to 3.3 V. Without them the ESP32 input will be damaged over time.
- **The dead sensor.** If the branch-1 pair ever reads 0 on one side with the pump running and a valve open, you are looking at the same failure that cost us the other lane — check `stat` before assuming a leak. `SENSOR_FAULT_PCT` catches the swapped/dead-IN case and logs it.

## 8. Finding the laptop

The rig connects TO the laptop, so it must know where the laptop is. In order of preference:

1. **The rig's own AP.** Nothing to configure, nothing to go wrong at the venue: let the Wi-Fi fail
   (or leave `ssid=` empty), join `rig-<id>` from the laptop, run the server on port 3000. The rig
   dials 192.168.4.2, which is the address the laptop gets.
2. **Your own phone hotspot or router, laptop on a reserved IP.** `server=ws://<ip>:3000/ws`.
3. **mDNS.** `server=ws://MacBook-Pro-7.local:3000/ws` (find the name with `scutil --get LocalHostName`).
   Survives DHCP changes, but some hotspots block mDNS between clients.

Two things break this on a network you do not control, and neither is a firmware bug:

- **Client isolation.** Guest and venue Wi-Fi often stops clients from seeing each other. Test with
  `ping <rig-ip>` from the laptop; no reply means isolation, and the answer is option 1 or 2.
- **The laptop firewall.** macOS asks to allow incoming connections the first time the Node server
  starts. If it was denied once: System Settings → Network → Firewall → Options.
