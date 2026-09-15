// console.h - the serial command line, on both the USB port and the UART0 pins.
// Type "help" for the list. "!" works instantly (no Enter) and switches every relay off.
#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include "config.h"
#include "log.h"
#include "state.h"
#include "relays.h"
#include "sim.h"
#include "flow.h"
#include "leak.h"
#include "json.h"
#include "net.h"

static char    g_lineUsb[96], g_lineUart[96];
static uint8_t g_lenUsb = 0, g_lenUart = 0;
static bool    g_telPrint = false;
static bool    g_scanPending = false;
static char    g_conBuf[768];

bool consoleTelPrint() { return g_telPrint; }

static void consoleHelp() {
  LOG("MENU", "!            all relays off now (no Enter needed)");
  LOG("MENU", "help show id wifi scan reboot");
  LOG("MENU", "ssid=<name> pass=<pw> server=ws://host:port/ws name=<mdns>  (saved, applied live)");
  LOG("MENU", "v1|v2|v3 on [sec] | off      valve open/close   pump on [sec] | off");
  LOG("MENU", "off (=all off)   reset (clear leak latches)   stat   adc   tel on|off");
  LOG("MENU", "cal | cal show | cal clear   (10 s sensor calibration, pump on, all valves open)");
  LOG("MENU", "sim on|off | sim flow <lpm> | sim leak <b> <pct> | sim burst <b> | sim mleak <pct> | sim clear");
}

static void consoleRunCmd(Cmd c) {
  c.src = SRC_SERIAL;
  AckMsg a = applyCmd(c);
  if (!a.ok) LOG("CMD", "refused: %s", ERR_NAMES[a.err]);
}

static void consoleStat() {
  LOG("STAT", "L/min m=%.2f b1=%.2f/%.2f b2=%.2f/%.2f b3=%.2f/%.2f", flowLpm(0), flowLpm(1), flowLpm(2), flowLpm(3), flowLpm(4), flowLpm(5), flowLpm(6));
  LOG("STAT", "pulses m=%lu b1=%lu/%lu b2=%lu/%lu b3=%lu/%lu", (unsigned long)flowRaw(0), (unsigned long)flowRaw(1), (unsigned long)flowRaw(2),
      (unsigned long)flowRaw(3), (unsigned long)flowRaw(4), (unsigned long)flowRaw(5), (unsigned long)flowRaw(6));
  LOG("STAT", "loss%% b1=%.1f b2=%.1f b3=%.1f leak=%u/%u/%u mleak=%u valves=%u%u%u pump=%u sim=%u",
      leakLoss(1), leakLoss(2), leakLoss(3), leakLevel(1), leakLevel(2), leakLevel(3), leakMleak(),
      relaysValveOn(1), relaysValveOn(2), relaysValveOn(3), relaysPumpOn(), simActive());
}

static void consoleAdc() {
  int turbMv, ntu, tdsMv, ppm;
  sensorsRead(&turbMv, &ntu, &tdsMv, &ppm);
  LOG("ADC", "turb=%d mV ntu=%d  tds=%d mV ppm=%d", turbMv, ntu, tdsMv, ppm);
}

static void consoleWifi() {
  LOG("WIFI", "status=%d ip=%s rssi=%d ws=%s id=%s", (int)WiFi.status(), WiFi.localIP().toString().c_str(),
      WiFi.RSSI(), netWsUp() ? "connected" : "down", netDeviceId());
}

static void consoleExec(char* line) {
  // settings: key=value
  char* eq = strchr(line, '=');
  if (eq && strchr(" \t", line[0]) == nullptr) {
    *eq = 0;
    const char* key = line; const char* val = eq + 1;
    if (!strcmp(key, "ssid") || !strcmp(key, "pass") || !strcmp(key, "server") || !strcmp(key, "name")) { netSaveCfg(key, val); return; }
    LOG("ERR", "unknown setting '%s'", key);
    return;
  }
  char* save = nullptr;
  char* w0 = strtok_r(line, " \t", &save);
  if (!w0) return;
  char* w1 = strtok_r(nullptr, " \t", &save);
  char* w2 = strtok_r(nullptr, " \t", &save);
  char* w3 = strtok_r(nullptr, " \t", &save);
  Cmd c = {}; c.pct = -1;

  if (!strcmp(w0, "help") || !strcmp(w0, "h") || !strcmp(w0, "?")) { consoleHelp(); return; }
  if (!strcmp(w0, "show")) { netShowCfg(); return; }
  if (!strcmp(w0, "id"))   { LOG("CFG", "id=%s fw=%s", netDeviceId(), FW_VERSION); return; }
  if (!strcmp(w0, "wifi")) { consoleWifi(); return; }
  if (!strcmp(w0, "scan")) { WiFi.scanNetworks(true); g_scanPending = true; LOG("WIFI", "scanning..."); return; }
  if (!strcmp(w0, "reboot")) { LOG("BOOT", "rebooting"); delay(100); ESP.restart(); return; }
  if (!strcmp(w0, "stat")) { consoleStat(); return; }
  if (!strcmp(w0, "adc"))  { consoleAdc(); return; }
  if (!strcmp(w0, "tel"))  { g_telPrint = w1 && !strcmp(w1, "on"); LOG("MENU", "tel print %s", g_telPrint ? "on" : "off"); return; }
  if (!strcmp(w0, "cal")) {
    if (!w1) flowCalStart(); else if (!strcmp(w1, "clear")) flowCalClear(); else flowCalShow();
    return;
  }
  if (!strcmp(w0, "off") || !strcmp(w0, "!")) { c.act = ACT_ALL_OFF; consoleRunCmd(c); return; }
  if (!strcmp(w0, "reset")) { c.act = ACT_RESET_LEAK; consoleRunCmd(c); return; }
  if ((w0[0] == 'v') && w0[1] >= '1' && w0[1] <= '3' && w0[2] == 0) {
    if (!w1) { LOG("ERR", "usage: v%c on [sec] | off", w0[1]); return; }
    c.act = ACT_VALVE; c.b = w0[1] - '0'; c.hasOn = true; c.on = !strcmp(w1, "on"); c.dur = w2 ? (uint16_t)atoi(w2) : 0;
    consoleRunCmd(c); return;
  }
  if (!strcmp(w0, "pump")) {
    if (!w1) { LOG("ERR", "usage: pump on [sec] | off"); return; }
    c.act = ACT_PUMP; c.hasOn = true; c.on = !strcmp(w1, "on"); c.dur = w2 ? (uint16_t)atoi(w2) : 0;
    consoleRunCmd(c); return;
  }
  if (!strcmp(w0, "sim")) {
    if (!w1 || !strcmp(w1, "on"))     simSet(true, SRC_SERIAL);
    else if (!strcmp(w1, "off"))      { simClear(); simSet(false, SRC_SERIAL); }
    else if (!strcmp(w1, "flow"))     simFlow(w2 ? atof(w2) : SIM_BASE_LPM);
    else if (!strcmp(w1, "leak"))     { if (!simActive()) simSet(true, SRC_SERIAL); simLeak(w2 ? atoi(w2) : 0, w3 ? atof(w3) : 35); }
    else if (!strcmp(w1, "burst"))    { if (!simActive()) simSet(true, SRC_SERIAL); simLeak(w2 ? atoi(w2) : 0, 85); }
    else if (!strcmp(w1, "mleak"))    { if (!simActive()) simSet(true, SRC_SERIAL); simMleak(w2 ? atof(w2) : 30); }
    else if (!strcmp(w1, "clear"))    simClear();
    else LOG("ERR", "usage: sim on|off|flow <lpm>|leak <b> <pct>|burst <b>|mleak <pct>|clear");
    return;
  }
  LOG("ERR", "unknown command '%s' (type help)", w0);
}

static void consoleFeed(Stream& s, char* buf, uint8_t& len) {
  while (s.available()) {
    char ch = (char)s.read();
    if (ch == '!') { relaysAllOff(SRC_SERIAL); len = 0; continue; }   // instant, no Enter
    if (ch == '\r') continue;
    if (ch == '\n') { buf[len] = 0; if (len) consoleExec(buf); len = 0; continue; }
    if (len < 95) buf[len++] = ch;
  }
}

void consoleInit() { LOG("MENU", "type 'help' for commands; '!' = all relays off"); }

void consoleTick() {
  consoleFeed(Serial, g_lineUsb, g_lenUsb);
  consoleFeed(Serial0, g_lineUart, g_lenUart);
  if (g_scanPending) {
    int16_t n = WiFi.scanComplete();
    if (n >= 0) {
      g_scanPending = false;
      LOG("WIFI", "scan: %d networks", (int)n);
      for (int16_t i = 0; i < n && i < 10; i++) LOG("WIFI", "  %-24s %4d dBm ch%2d", WiFi.SSID(i).c_str(), (int)WiFi.RSSI(i), (int)WiFi.channel(i));
      WiFi.scanDelete();
    } else if (n == WIFI_SCAN_FAILED) { g_scanPending = false; LOG("WIFI", "scan failed"); }
  }
}

// Print the same telemetry JSON the server receives (console command "tel on").
void consolePrintTel(const Snapshot& s) {
  jsonTel(g_conBuf, sizeof g_conBuf, s, WiFi.RSSI(), millis() / 1000, ESP.getFreeHeap());
  Serial.println(g_conBuf);
  Serial0.println(g_conBuf);
}
