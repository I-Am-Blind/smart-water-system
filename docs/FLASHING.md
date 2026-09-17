# Flashing `rig_diagnostic_v1` (hardware bring-up)

This sketch checks the wiring and health of the rig. It never switches a relay on by itself; relays only move when you press the keys listed at the bottom, and any relay you switch on turns itself off again after 20 seconds.

It still sweeps the full original wiring — 7 flow inputs and 3 solenoid relays — which is exactly what you want when hunting a fault. The rig as built uses two branches, one IN/OUT sensor pair and two solenoids (`docs/PROTOCOL.md` §0), so the extra inputs reading zero here is expected, not a failure.

## Arduino IDE settings (Tools menu)

Install the **esp32 by Espressif Systems** board package (3.x) from Boards Manager first. Then set:

| Tools menu item | Value |
|---|---|
| Board | ESP32S3 Dev Module |
| USB CDC On Boot | **Enabled** |
| USB Mode | Hardware CDC and JTAG |
| Flash Mode | QIO 80MHz |
| Flash Size | 16MB (128Mb) |
| PSRAM | **OPI PSRAM** |
| Partition Scheme | Default 4MB with spiffs (leave as is) |
| Upload Speed | 921600 (or 115200 if uploads fail) |
| Port | the port that appears when the board is plugged in |

No libraries need to be installed. The board prints these required settings in its boot banner so you can compare.

## How to flash and what to send back

1. Open `firmware/rig_diagnostic_v1/rig_diagnostic_v1.ino` in the Arduino IDE, set the Tools menu exactly as in the table above, plug in the board (either USB port works) and click **Upload**. If the upload does not start, hold the BOOT button, tap RESET, release BOOT, and click Upload again.
2. Open **Tools > Serial Monitor**, set it to **115200 baud**, then press the board's RESET button. The log restarts with a 3-second countdown and runs the automatic tests for about 20 seconds (do not touch anything, water must be OFF).
3. Wait for the block that starts with `===DIAG_SUMMARY_BEGIN===` and ends with `===DIAG_SUMMARY_END===`. Select **everything** in the monitor from the first `[BOOT]` line down to `===DIAG_SUMMARY_END===` and paste it into your message back.
4. Then type `f` and press Enter, and while it counts for 15 seconds blow hard through one flow sensor (or run water through it). Paste those 15 seconds of `[PULSE]` lines too, and say which sensor you used.
5. If you see nothing at all: try the other USB port on the board, then press `b` + Enter to change the UART speed (the log tells you the new speed), and if it still stays blank, send a photo of the Tools menu.

## Keys (type one letter, Enter is optional)

| Key | What it does |
|---|---|
| `h` | Print the menu again |
| `s` | Print the summary block again |
| `f` | 15-second live flow watch: pulses per second and litres/minute for every sensor |
| `a` | Stream both analog sensors (turbidity, TDS) twice a second for 10 seconds |
| `l` | Repeat the 10-second idle pulse listen |
| `1` `2` `3` | Toggle solenoid relay V1 / V2 / V3 (turns itself off after 20 s) |
| `P` | Pump relay: asks you to press `y` within 5 seconds before it switches on (auto-off 20 s). If the pump is on, `P` turns it off at once |
| `!` | EMERGENCY: all relays off immediately |
| `b` | Switch the UART port (Serial0) between 9600, 57600, 115200 and 230400 baud. The native USB port is not affected |

Reading the summary: `PASS` = fine, `WARN` = look at the reason but the board works, `FAIL` = something is wrong with the board settings or wiring (the reason says what).
