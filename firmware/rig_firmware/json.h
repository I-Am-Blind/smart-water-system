// json.h - builds and parses the wire messages (docs/PROTOCOL.md). ArduinoJson 7.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include "config.h"
#include "state.h"

static float round2(float x) { return roundf(x * 100.0f) / 100.0f; }
static float round1(float x) { return roundf(x * 10.0f) / 10.0f; }

// {"t":"hello","proto":1,"id":"rig-7a3f21","fw":"1.0.0","ip":"...","rssi":-58,"rst":"POWERON","sim":false}
size_t jsonHello(char* buf, size_t n, const char* id, const char* ip, int rssi, const char* rst, bool sim) {
  JsonDocument d;
  d["t"] = "hello"; d["proto"] = 1; d["id"] = id; d["fw"] = FW_VERSION; d["ip"] = ip;
  d["rssi"] = rssi; d["rst"] = rst; d["sim"] = sim;
  return serializeJson(d, buf, n);
}

// Telemetry: field order and names are fixed by the protocol.
size_t jsonTel(char* buf, size_t n, const Snapshot& s, int rssi, uint32_t upS, uint32_t heap) {
  JsonDocument d;
  d["t"] = "tel"; d["ms"] = s.ms; d["seq"] = s.seq;
  JsonArray f = d["f"].to<JsonArray>();
  for (uint8_t i = 0; i < 7; i++) f.add((float)round2(s.lpm[i]));
  JsonArray p = d["p"].to<JsonArray>();
  for (uint8_t i = 0; i < 7; i++) p.add(s.pulses[i]);
  JsonArray loss = d["loss"].to<JsonArray>();
  for (uint8_t b = 0; b < 3; b++) loss.add((float)round1(s.loss[b]));
  JsonArray leak = d["leak"].to<JsonArray>();
  for (uint8_t b = 0; b < 3; b++) leak.add(s.leak[b]);
  d["mleak"] = s.mleak;
  JsonArray v = d["v"].to<JsonArray>();
  for (uint8_t b = 0; b < 3; b++) v.add(s.valve[b]);
  d["pump"] = s.pump;
  d["turb"]["mv"] = s.turbMv; d["turb"]["ntu"] = s.ntu;
  d["tds"]["mv"] = s.tdsMv;   d["tds"]["ppm"] = s.ppm;
  d["rssi"] = rssi; d["up"] = upS; d["heap"] = heap; d["sim"] = s.sim;
  return serializeJson(d, buf, n);
}

size_t jsonEvt(char* buf, size_t n, const Evt& e) {
  JsonDocument d;
  d["t"] = "evt"; d["ms"] = e.ms; d["ev"] = EV_NAMES[e.ev];
  if (e.b) d["b"] = e.b;
  if (e.kind != LK_NONE) d["kind"] = KIND_NAMES[e.kind];
  if (e.loss >= 0) d["loss"] = (float)round1(e.loss);
  if (e.on >= 0) d["on"] = (uint8_t)e.on;
  d["src"] = SRC_NAMES[e.src];
  if (e.reason != RSN_NONE) d["reason"] = REASON_NAMES[e.reason];
  return serializeJson(d, buf, n);
}

size_t jsonAck(char* buf, size_t n, const AckMsg& a) {
  JsonDocument d;
  d["t"] = "ack"; d["id"] = a.id; d["ok"] = a.ok;
  if (a.err != ERR_NONE) d["err"] = ERR_NAMES[a.err];
  if (a.ok && a.ms) d["ms"] = a.ms;
  return serializeJson(d, buf, n);
}

// Parse {"t":"cmd","id":17,"act":"valve","b":2,"on":true,"dur":120}. requireT: the WebSocket path insists
// on t=="cmd"; the local HTTP /cmd accepts a bare body. Returns ERR_NONE, ERR_BAD_JSON or ERR_UNKNOWN_ACT.
Err jsonParseCmd(const char* txt, size_t len, bool requireT, Cmd& c) {
  JsonDocument d;
  c = Cmd{};
  c.pct = -1;
  if (deserializeJson(d, txt, len) != DeserializationError::Ok) return ERR_BAD_JSON;
  if (!d.is<JsonObject>()) return ERR_BAD_JSON;
  const char* t = d["t"] | (const char*)nullptr;
  if (requireT && (!t || strcmp(t, "cmd") != 0)) return ERR_BAD_JSON;
  if (t && strcmp(t, "cmd") != 0) return ERR_BAD_JSON;
  c.id = d["id"] | 0UL;
  const char* act = d["act"] | (const char*)nullptr;
  if (!act) return ERR_BAD_JSON;
  if      (!strcmp(act, "valve"))      c.act = ACT_VALVE;
  else if (!strcmp(act, "pump"))       c.act = ACT_PUMP;
  else if (!strcmp(act, "all_off"))    c.act = ACT_ALL_OFF;
  else if (!strcmp(act, "reset_leak")) c.act = ACT_RESET_LEAK;
  else if (!strcmp(act, "ping"))       c.act = ACT_PING;
  else if (!strcmp(act, "sim"))        c.act = ACT_SIM;
  else { c.act = ACT_UNKNOWN; return ERR_UNKNOWN_ACT; }
  c.b = (uint8_t)(d["b"] | 0);
  if (d["on"].is<bool>()) { c.hasOn = true; c.on = d["on"].as<bool>(); }
  int dur = d["dur"] | 0;
  c.dur = (uint16_t)(dur < 0 ? 0 : (dur > 65535 ? 65535 : dur));
  if (d["pct"].is<float>() || d["pct"].is<int>()) c.pct = (int16_t)(d["pct"].as<float>());
  return ERR_NONE;
}
