// net.h - Wi-Fi, WebSocket client, mDNS and the local HTTP fallback. Runs entirely in its own
// FreeRTOS task on core 0 so a slow connect can never stall the safety loop on core 1.
// Settings (ssid, pass, server, name) live in NVS and are changed from the serial console.
#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WebSocketsClient.h>
#include "esp_system.h"
#include "esp_mac.h"
#include "branding.h"
#include "config.h"
#include "log.h"
#include "state.h"
#include "sim.h"
#include "json.h"

struct NetCfg { char ssid[33]; char pass[65]; char server[128]; char name[25]; };

static NetCfg   g_cfg;                       // copy used by the net task
static char     g_devId[16] = "rig-000000";
static char     g_rstName[12] = "UNKNOWN";
static volatile bool g_wifiUp = false;
static bool     g_wifiWasUp = false;
static uint32_t g_wifiDownSince = 0;
static bool     g_wifiStarted = false;
static uint32_t g_appliedCfgVersion = 0xFFFFFFFF;
static WebSocketsClient g_ws;
static WebServer g_http(HTTP_PORT);
static bool     g_httpStarted = false;
static bool     g_mdnsUp = false;
static bool     g_wsConfigured = false;
static volatile bool g_wsUp = false;
static uint32_t g_wsRetryMs = WS_RECONNECT_MIN_MS;
static uint32_t g_wsDownSince = 0;
static uint32_t g_wsLastNagMs = 0;
static uint32_t g_wsResolveRetryAt = 0;
static uint32_t g_lastTelMs = 0;
static uint32_t g_httpCmdSeq = 0;
static char     g_wsHost[96]; static uint16_t g_wsPort = 80; static char g_wsPath[64] = "/ws"; static bool g_wsSsl = false;
static char     g_netBuf[768];

// ---------------------------------------------------------------- settings (NVS namespace "rig")
void netLoadCfg(NetCfg& c) {
  Preferences p;
  p.begin("rig", true);
  strlcpy(c.ssid,   p.getString("ssid",   DEFAULT_WIFI_SSID).c_str(),  sizeof c.ssid);
  strlcpy(c.pass,   p.getString("pass",   DEFAULT_WIFI_PASS).c_str(),  sizeof c.pass);
  strlcpy(c.server, p.getString("server", DEFAULT_SERVER_URL).c_str(), sizeof c.server);
  strlcpy(c.name,   p.getString("name",   BRAND_DEVICE_NAME).c_str(),  sizeof c.name);
  p.end();
  if (!c.server[0]) strlcpy(c.server, DEFAULT_SERVER_URL, sizeof c.server);
  if (!c.name[0])   strlcpy(c.name, BRAND_DEVICE_NAME, sizeof c.name);
}

// key = "ssid" | "pass" | "server" | "name". Takes effect live: the net task re-applies on the next pass.
void netSaveCfg(const char* key, const char* value) {
  Preferences p;
  p.begin("rig", false);
  p.putString(key, value);
  p.end();
  g_cfgVersion = g_cfgVersion + 1;
  LOG("CFG", "saved %s, applying", key);
}

void netShowCfg() {
  NetCfg c; netLoadCfg(c);
  LOG("CFG", "ssid='%s' pass=%s server=%s name=%s id=%s", c.ssid, c.pass[0] ? "***" : "(none)", c.server, c.name, g_devId);
}

const char* netDeviceId() { return g_devId; }
bool netWifiUp() { return g_wifiUp; }
bool netWsUp()   { return g_wsUp; }

// ---------------------------------------------------------------- helpers
static const char* resetName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:   return "POWERON";
    case ESP_RST_SW:        return "SW";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INT_WDT";
    case ESP_RST_TASK_WDT:  return "TASK_WDT";
    case ESP_RST_WDT:       return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    case ESP_RST_SDIO:      return "SDIO";
    default:                return "UNKNOWN";
  }
}

// ws://host:port/path or wss://host/path
static bool parseUrl(const char* url) {
  const char* p = url;
  g_wsSsl = false;
  if (!strncmp(p, "wss://", 6)) { g_wsSsl = true; p += 6; }
  else if (!strncmp(p, "ws://", 5)) { p += 5; }
  else return false;
  const char* slash = strchr(p, '/');
  const char* colon = strchr(p, ':');
  size_t hostLen;
  if (colon && (!slash || colon < slash)) { hostLen = (size_t)(colon - p); g_wsPort = (uint16_t)atoi(colon + 1); }
  else { hostLen = slash ? (size_t)(slash - p) : strlen(p); g_wsPort = g_wsSsl ? 443 : 80; }
  if (hostLen == 0 || hostLen >= sizeof g_wsHost) return false;
  memcpy(g_wsHost, p, hostLen); g_wsHost[hostLen] = 0;
  strlcpy(g_wsPath, slash ? slash : "/", sizeof g_wsPath);
  return true;
}

// ---------------------------------------------------------------- WebSocket
static void wsSend(const char* txt) { g_ws.sendTXT(txt); }

static void wsSendAck(const AckMsg& a) {
  if (!g_wsUp) return;
  jsonAck(g_netBuf, sizeof g_netBuf, a);
  wsSend(g_netBuf);
}

static void wsSendHello() {
  jsonHello(g_netBuf, sizeof g_netBuf, g_devId, WiFi.localIP().toString().c_str(), WiFi.RSSI(), g_rstName, simActive());
  wsSend(g_netBuf);
  LOG("WS", "tx hello id=%s", g_devId);
}

// Text from the server: only "cmd" is expected. Parse errors are acked here; real commands go to loop().
static void handleCmdText(const char* txt, size_t len, Src src) {
  Cmd c;
  Err e = jsonParseCmd(txt, len, true, c);
  c.src = src;
  if (e != ERR_NONE) {
    AckMsg a = { c.id, false, e, millis(), src };
    LOG("CMD", "rejected (%s): %.*s", ERR_NAMES[e], (int)(len > 80 ? 80 : len), txt);
    wsSendAck(a);
    return;
  }
  if (!cmdPost(c)) LOG("CMD", "queue full, dropped id=%lu", (unsigned long)c.id);
}

static void wsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      g_wsUp = true;
      g_wsRetryMs = WS_RECONNECT_MIN_MS;
      g_ws.setReconnectInterval(g_wsRetryMs);
      LOG("WS", "connected %s:%u%s", g_wsHost, (unsigned)g_wsPort, g_wsPath);
      wsSendHello();
      g_lastTelMs = 0;   // send a tel right away
      break;
    case WStype_DISCONNECTED:
      if (g_wsUp) { LOG("WS", "disconnected"); g_wsDownSince = millis(); }
      g_wsUp = false;
      break;
    case WStype_TEXT:
      handleCmdText((const char*)payload, length, SRC_WS);
      break;
    case WStype_ERROR:
      LOG("WS", "error");
      break;
    default:
      break;
  }
}

// Dial the server from the stored URL. Called whenever Wi-Fi is up and the client is not configured.
static void wsStart() {
  if (millis() < g_wsResolveRetryAt) return;
  if (!parseUrl(g_cfg.server)) {
    LOG("WS", "bad server url '%s' (want ws://host:port/ws)", g_cfg.server);
    g_wsResolveRetryAt = millis() + 60000;
    return;
  }
  g_ws.onEvent(wsEvent);
  g_ws.setReconnectInterval(WS_RECONNECT_MIN_MS);
  g_ws.enableHeartbeat(WS_PING_MS, WS_PONG_TIMEOUT_MS, WS_PONG_MISSES);
  size_t hl = strlen(g_wsHost);
  if (hl > 6 && !strcmp(g_wsHost + hl - 6, ".local")) {
    char bare[96]; strlcpy(bare, g_wsHost, sizeof bare); bare[hl - 6] = 0;
    IPAddress ip = MDNS.queryHost(bare, 2000);
    if (ip == IPAddress((uint32_t)0)) {
      LOG("WS", "cannot resolve %s via mDNS, retry in 5s", g_wsHost);
      g_wsResolveRetryAt = millis() + 5000;
      return;
    }
    LOG("WS", "%s -> %s", g_wsHost, ip.toString().c_str());
    g_ws.begin(ip, g_wsPort, g_wsPath);
  } else if (g_wsSsl) {
    g_ws.beginSSL(g_wsHost, g_wsPort, g_wsPath);   // no certificate check (fine for a demo)
  } else {
    g_ws.begin(g_wsHost, g_wsPort, g_wsPath);
  }
  g_wsConfigured = true;
  g_wsDownSince = millis();
  g_wsLastNagMs = millis();
  LOG("WS", "connecting %s://%s:%u%s", g_wsSsl ? "wss" : "ws", g_wsHost, (unsigned)g_wsPort, g_wsPath);
}

// A failed dial is silent inside the library, so the retry pace and the "still trying" log live here.
// Retry every 2 s for the first 30 s, then every 10 s for two minutes, then every 30 s forever.
static void wsBackoff() {
  if (g_wsUp) return;
  uint32_t down = millis() - g_wsDownSince;
  uint32_t want = down < 30000 ? WS_RECONNECT_MIN_MS : (down < 150000 ? 10000 : WS_RECONNECT_MAX_MS);
  if (want != g_wsRetryMs) { g_wsRetryMs = want; g_ws.setReconnectInterval(want); }
  if (millis() - g_wsLastNagMs >= 30000) {
    g_wsLastNagMs = millis();
    LOG("WS", "no server at %s:%u, retrying every %lus", g_wsHost, (unsigned)g_wsPort, (unsigned long)(want / 1000));
  }
}

static void wsStop() {
  if (g_wsConfigured) g_ws.disconnect();
  g_wsConfigured = false;
  g_wsUp = false;
}

// ---------------------------------------------------------------- local HTTP fallback (http://<name>.local)
static void httpCors() {
  g_http.sendHeader("Access-Control-Allow-Origin", "*");
  g_http.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

static void httpStatus() {
  Snapshot s; snapshotCopy(s);
  jsonTel(g_netBuf, sizeof g_netBuf, s, WiFi.RSSI(), millis() / 1000, ESP.getFreeHeap());
  httpCors();
  g_http.send(200, "application/json", g_netBuf);
}

static void httpReply(int code, bool ok, Err err) {
  httpCors();
  if (ok) g_http.send(code, "application/json", "{\"ok\":true}");
  else { snprintf(g_netBuf, sizeof g_netBuf, "{\"ok\":false,\"err\":\"%s\"}", ERR_NAMES[err]); g_http.send(code, "application/json", g_netBuf); }
}

static void httpCmd() {
  if (g_http.method() == HTTP_OPTIONS) { httpCors(); g_http.send(204); return; }
  if (!g_http.hasArg("plain")) { httpReply(400, false, ERR_BAD_JSON); return; }
  String body = g_http.arg("plain");
  Cmd c;
  Err e = jsonParseCmd(body.c_str(), body.length(), false, c);
  if (e != ERR_NONE) { httpReply(400, false, e); return; }
  c.src = SRC_HTTP;
  c.id = 0x80000000UL | (++g_httpCmdSeq & 0xFFFF);
  if (!cmdPost(c)) { httpReply(503, false, ERR_BAD_JSON); return; }
  uint32_t t0 = millis();
  AckMsg a;
  while (millis() - t0 < 500) {                     // loop() applies commands within a few ms
    if (xQueueReceive(g_ackQ, &a, pdMS_TO_TICKS(20)) != pdTRUE) continue;
    if (a.src == SRC_HTTP && a.id == c.id) { httpReply(a.ok ? 200 : 409, a.ok, a.err); return; }
    if (a.src == SRC_WS) wsSendAck(a);              // not ours: forward to the WebSocket
  }
  httpCors();
  g_http.send(504, "application/json", "{\"ok\":false,\"err\":\"timeout\"}");
}

static void httpStart() {
  if (g_httpStarted) return;
  g_http.on("/status", HTTP_GET, httpStatus);
  g_http.on("/cmd", httpCmd);
  g_http.onNotFound([]() { httpCors(); g_http.send(404, "text/plain", "try /status or POST /cmd"); });
  g_http.begin();
  g_httpStarted = true;
}

// ---------------------------------------------------------------- Wi-Fi
static void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      g_wifiUp = true;
      LOG("WIFI", "got ip %s rssi=%d", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      if (g_wifiUp) LOG("WIFI", "disconnected reason=%u", (unsigned)info.wifi_sta_disconnected.reason);
      g_wifiUp = false;
      break;
    default:
      break;
  }
}

// (Re)load settings and (re)start Wi-Fi + WebSocket. Runs in the net task.
static void netApplyCfg() {
  g_appliedCfgVersion = g_cfgVersion;
  netLoadCfg(g_cfg);
  wsStop();
  g_wsResolveRetryAt = 0;
  if (g_wifiStarted) WiFi.disconnect();
  g_wifiUp = false;
  g_wifiDownSince = millis();
  WiFi.setHostname(g_cfg.name);
  if (!g_cfg.ssid[0]) { LOG("WIFI", "no ssid configured, offline mode (type: ssid=YourNetwork)"); return; }
  LOG("WIFI", "connecting to '%s'", g_cfg.ssid);
  WiFi.begin(g_cfg.ssid, g_cfg.pass);
  g_wifiStarted = true;
}

static void netTask(void*) {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.onEvent(onWifiEvent);
  netApplyCfg();
  for (;;) {
    if (g_appliedCfgVersion != g_cfgVersion) netApplyCfg();

    bool up = g_wifiUp;
    if (up && !g_wifiWasUp) {                       // just came up
      if (!g_mdnsUp && MDNS.begin(g_cfg.name)) { MDNS.addService("http", "tcp", HTTP_PORT); g_mdnsUp = true; LOG("MDNS", "http://%s.local", g_cfg.name); }
      httpStart();
    }
    if (!up && g_wifiWasUp) { wsStop(); g_wifiDownSince = millis(); }
    g_wifiWasUp = up;

    // Backstop: the driver auto-reconnects, but if it gives up we kick it every WIFI_BACKSTOP_S.
    if (!up && g_wifiStarted && millis() - g_wifiDownSince > (uint32_t)WIFI_BACKSTOP_S * 1000UL) {
      g_wifiDownSince = millis();
      LOG("WIFI", "still down, retrying '%s'", g_cfg.ssid);
      WiFi.disconnect();
      WiFi.begin(g_cfg.ssid, g_cfg.pass);
    }

    if (up) {
      if (!g_wsConfigured) wsStart();
      if (g_wsConfigured) { wsBackoff(); g_ws.loop(); }
      g_http.handleClient();
      if (g_wsUp && millis() - g_lastTelMs >= TEL_PERIOD_MS) {
        g_lastTelMs = millis();
        Snapshot s; snapshotCopy(s);
        jsonTel(g_netBuf, sizeof g_netBuf, s, WiFi.RSSI(), millis() / 1000, ESP.getFreeHeap());
        wsSend(g_netBuf);
      }
    }
    // Events: sent when connected, otherwise dropped (the next tel carries full state).
    Evt e;
    while (xQueueReceive(g_evtQ, &e, 0) == pdTRUE) {
      if (g_wsUp) { jsonEvt(g_netBuf, sizeof g_netBuf, e); wsSend(g_netBuf); }
    }
    AckMsg a;
    while (xQueueReceive(g_ackQ, &a, 0) == pdTRUE) {
      if (a.src == SRC_WS) wsSendAck(a);            // HTTP acks are consumed inside httpCmd()
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

void netInit() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(g_devId, sizeof g_devId, "rig-%02x%02x%02x", mac[3], mac[4], mac[5]);
  strlcpy(g_rstName, resetName(esp_reset_reason()), sizeof g_rstName);
  netShowCfg();
  xTaskCreatePinnedToCore(netTask, "net", NET_TASK_STACK, nullptr, 1, nullptr, NET_TASK_CORE);
}
