/*
 * rig_firmware - production firmware for the water-leak-detection rig (ESP32-S3-WROOM-1 N16R8).
 *
 * What it does, in one breath: counts pulses from 7 flow sensors, compares each branch's IN and OUT
 * flow every second, closes the solenoid of a leaking branch, keeps every relay under a maximum
 * on-time, and streams telemetry over one WebSocket to the server (docs/PROTOCOL.md). All safety
 * logic runs on core 1 with no dependency on Wi-Fi; networking lives in its own task on core 0.
 *
 * Arduino IDE: ESP32S3 Dev Module, USB CDC On Boot: Enabled, Flash: QIO 80MHz / 16MB,
 * PSRAM: OPI PSRAM, Partition: Huge APP. Libraries: ArduinoJson 7.x, WebSockets 2.7.x (Markus Sattler).
 * See firmware/README.md for setup, serial commands and the bench test.
 */
#include "config.h"
#include "branding.h"
#include "log.h"
#include "state.h"
#include "relays.h"
#include "sim.h"
#include "flow.h"
#include "leak.h"
#include "json.h"
#include "net.h"
#include "console.h"

static uint32_t g_seq = 0;
static uint32_t g_nextSampleMs = 0;
static uint32_t g_nextRelayMs = 0;

void setup() {
  relaysSafeInit();            // FIRST: every relay off before anything else can run
  logBegin();
  delay(50);
  LOG("BOOT", "%s firmware %s built %s %s", BRAND_NAME, FW_VERSION, __DATE__, __TIME__);
  LOG("BOOT", "chip=%s cpu=%luMHz flash=%luMB psram=%luKB core=%s",
      ESP.getChipModel(), (unsigned long)ESP.getCpuFreqMHz(), (unsigned long)(ESP.getFlashChipSize() / (1024 * 1024)),
      (unsigned long)(ESP.getPsramSize() / 1024), ESP.getCoreVersion());
  stateInit();
  relaysInit();
  flowInit();
  sensorsInit();
  leakInit();
  netInit();                   // starts the core-0 network task
  consoleInit();
  evtPost(EV_BOOT, 0, SRC_BOOT);
  uint32_t now = millis();
  g_nextSampleMs = now + SAMPLE_MS;
  g_nextRelayMs = now + RELAY_TICK_MS;
}

void loop() {
  uint32_t now = millis();

  consoleTick();                                     // serial input from both ports

  Cmd c;                                             // commands from the network task
  while (xQueueReceive(g_cmdQ, &c, 0) == pdTRUE) {
    AckMsg a = applyCmd(c);
    if (c.src == SRC_WS || c.src == SRC_HTTP) ackPost(a);
  }

  if ((int32_t)(now - g_nextRelayMs) >= 0) {         // every 100 ms: max-on timers
    g_nextRelayMs += RELAY_TICK_MS;
    relaysTick(now);
  }

  if ((int32_t)(now - g_nextSampleMs) >= 0) {        // every second: measure, judge, publish
    g_nextSampleMs += SAMPLE_MS;
    flowSample(now);
    Snapshot s = {};
    sensorsRead(&s.turbMv, &s.ntu, &s.tdsMv, &s.ppm);
    leakTick(now);
    s.ms = now; s.seq = ++g_seq;
    for (uint8_t i = 0; i < 7; i++) { s.lpm[i] = flowLpm(i); s.pulses[i] = flowRaw(i); }
    for (uint8_t b = 0; b < 3; b++) { s.loss[b] = leakLoss(b + 1); s.leak[b] = leakLevel(b + 1); s.valve[b] = relaysValveOn(b + 1) ? 1 : 0; }
    s.mleak = leakMleak();
    s.pump = relaysPumpOn() ? 1 : 0;
    s.sim = simActive();
    snapshotPublish(s);
    if (consoleTelPrint()) consolePrintTel(s);
  }

  delay(1);                                          // yield; nothing above ever blocks
}

// Apply one command from serial, WebSocket or HTTP. Returns the ack to send back.
AckMsg applyCmd(const Cmd& c) {
  AckMsg a = { c.id, true, ERR_NONE, millis(), c.src };
  Err err = ERR_NONE;
  switch (c.act) {
    case ACT_VALVE:
      if (c.b < 1 || c.b > 3) { err = ERR_BAD_BRANCH; break; }
      if (c.hasOn && c.on && leakIsLatched(c.b)) { err = ERR_LATCHED; break; }
      LOG("CMD", "valve b=%u %s dur=%u src=%s", c.b, (c.hasOn ? c.on : true) ? "on" : "off", (unsigned)c.dur, SRC_NAMES[c.src]);
      relaysValveSet(c.b, c.hasOn ? c.on : true, c.dur, c.src, &err);
      break;
    case ACT_PUMP:
      LOG("CMD", "pump %s dur=%u src=%s", (c.hasOn ? c.on : true) ? "on" : "off", (unsigned)c.dur, SRC_NAMES[c.src]);
      relaysPumpSet(c.hasOn ? c.on : true, c.dur, c.src, &err);
      break;
    case ACT_ALL_OFF:
      relaysAllOff(c.src);
      break;
    case ACT_RESET_LEAK:
      leakReset(c.src);
      break;
    case ACT_PING:
      break;
    case ACT_SIM:
      if (c.hasOn && !c.on && c.b == 0) { simClear(); simSet(false, c.src); }
      else {
        if (!simActive()) simSet(true, c.src);
        if (c.b >= 1 && c.b <= 3 && c.pct >= 0) simLeak(c.b, (float)c.pct);
      }
      break;
    default:
      err = ERR_UNKNOWN_ACT;
      break;
  }
  if (err != ERR_NONE) { a.ok = false; a.err = err; }
  return a;
}
