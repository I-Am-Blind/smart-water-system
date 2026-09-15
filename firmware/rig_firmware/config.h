// config.h - every pin, threshold and default in one place.
// Beginners: this is the only file you should need to touch to tune the rig.
#pragma once
#include <Arduino.h>

#define FW_VERSION "1.0.0"

// ---------------------------------------------------------------- pins
// 7x YF-S401 flow sensors, open-collector pulse output (FALLING edges), level shifted to 3.3 V.
// Order is fixed by the wire protocol: [master, b1 in, b1 out, b2 in, b2 out, b3 in, b3 out]
#define F0_MASTER 4
#define F1_IN     5
#define F1_OUT    6
#define F2_IN     7
#define F2_OUT    15
#define F3_IN     16
#define F3_OUT    17
static const uint8_t FLOW_PINS[7] = { F0_MASTER, F1_IN, F1_OUT, F2_IN, F2_OUT, F3_IN, F3_OUT };
static const char* const FLOW_NAMES[7] = { "m", "b1i", "b1o", "b2i", "b2o", "b3i", "b3o" };

// Analog sensors (both on ADC1; ADC2 pins are unusable while Wi-Fi runs).
#define TURBIDITY_PIN 8   // via 10k/20k divider: pin sees 2/3 of the sensor voltage
#define TDS_PIN       9   // Seeed Grove TDS, direct, max ~2.3 V

// 4-channel relay module, ACTIVE-LOW: LOW = relay energised.
// Valve relays drive normally-closed solenoids: energised = valve OPEN.
#define RELAY_V1   11
#define RELAY_V2   12
#define RELAY_V3   13
#define RELAY_PUMP 14
static const uint8_t RELAY_PINS[4] = { RELAY_V1, RELAY_V2, RELAY_V3, RELAY_PUMP };
// Never touch: 0,3,45,46 (strapping) 19,20 (USB) 26-32 (flash) 35,36,37 (PSRAM) 43,44 (UART0)

// ---------------------------------------------------------------- relay safety
#define VALVE_MAX_ON_S              600   // a valve may stay open at most 10 min per command (coil heat)
#define PUMP_DEFAULT_ON_S           20    // pump on without a duration stops after 20 s
#define PUMP_MAX_ON_S               300   // longest pump run a single command may request
#define PUMP_NEEDS_OPEN_VALVE       1     // 1 = refuse to start the pump when every valve is closed
#define AUTO_PUMP_OFF_WHEN_ALL_CLOSED 1   // 1 = stop the pump when the last open valve closes
#define AUTO_PUMP_OFF_ON_MANIFOLD   1     // 1 = stop the pump when a manifold (pre-valve) leak is latched
#define RELAY_TICK_MS               100   // how often the max-on timers are checked

// ---------------------------------------------------------------- flow measurement
#define FLOW_HZ_PER_LPM  98.0f   // YF-S401: pulses/s = 98 x L/min (5880 pulses per litre)
#define FLOW_GLITCH_US   500     // ignore edges closer than this (real max ~600 Hz = 1.7 ms period)
#define SAMPLE_MS        1000    // flow is evaluated once per second
#define ADC_SAMPLES      8       // analog reads averaged per sample
#define TURB_DIVIDER     1.5f    // multiply pin mV by this to get the sensor's own output voltage

// ---------------------------------------------------------------- leak detection (tune here)
#define LEAK_WINDOW_S          3      // seconds of pulses summed before comparing IN vs OUT (averages +/-1 pulse noise)
#define LEAK_MIN_FLOW_LPM      0.5f   // below this IN flow the sensors are too coarse to judge: no decision is made
#define LEAK_WARN_PCT          12.0f  // loss above this is shown as "warn" in the UI, no action
#define LEAK_DRIP_PCT          20.0f  // loss at/above this for LEAK_DRIP_CONFIRM_S seconds = drip leak (2x sensor mismatch)
#define LEAK_BURST_PCT         50.0f  // loss at/above this for LEAK_BURST_CONFIRM_S seconds = burst leak
#define LEAK_CLEAR_PCT         10.0f  // counters only reset when loss falls below this (hysteresis)
#define LEAK_DRIP_CONFIRM_S    5      // consecutive seconds of drip-level loss before the valve is closed
#define LEAK_BURST_CONFIRM_S   2      // consecutive seconds of burst-level loss before the valve is closed
#define LEAK_SETTLE_S          4      // ignore a branch this long after its valve or the pump changes (pipe filling)
#define SENSOR_FAULT_PCT      -20.0f  // OUT reading more than IN by this much = sensor/wiring problem, log only
#define MANIFOLD_MIN_FLOW_LPM  0.8f   // master flow needed before the manifold check runs
#define MANIFOLD_LOSS_PCT      25.0f  // master minus sum of open-branch IN flows, as % of master
#define MANIFOLD_CONFIRM_S     5      // consecutive seconds before the pump is stopped for a manifold leak

// ---------------------------------------------------------------- simulation
#define SIM_BASE_LPM 1.2f   // per-branch flow the simulator produces with pump on and valve open

// ---------------------------------------------------------------- network defaults (override over serial, stored in NVS)
#define DEFAULT_WIFI_SSID  ""
#define DEFAULT_WIFI_PASS  ""
#define DEFAULT_SERVER_URL "ws://192.168.0.3:3000/ws"
#define WIFI_BACKSTOP_S    60     // if not connected for this long, call WiFi.begin() again
#define WS_RECONNECT_MIN_MS 2000  // first retry delay after a WebSocket drop
#define WS_RECONNECT_MAX_MS 30000 // retry delay doubles up to this
#define WS_PING_MS         15000  // WebSocket heartbeat ping interval
#define WS_PONG_TIMEOUT_MS 3000   // pong must arrive within this
#define WS_PONG_MISSES     2      // missed pongs before the link is dropped and re-dialled
#define TEL_PERIOD_MS      1000   // telemetry rate
#define HTTP_PORT          80     // local fallback status server
#define NET_TASK_STACK     16384  // bytes; TLS + JSON + WebServer need room
#define NET_TASK_CORE      0      // Wi-Fi/lwIP already run on core 0; loop() runs on core 1
