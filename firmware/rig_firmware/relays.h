// relays.h - the only file that writes to the relay pins.
// Rules: nothing energises on boot; every ON has a maximum on-time; the pump is interlocked with the valves;
// every change is logged and sent to the server as an "evt".
#pragma once
#include <Arduino.h>
#include "driver/gpio.h"
#include "config.h"
#include "log.h"
#include "state.h"

struct Relay {
  uint8_t  pin;
  bool     on;
  uint32_t onSinceMs;
  uint32_t maxOnMs;
};
static Relay g_relay[4] = { { RELAY_V1, false, 0, 0 }, { RELAY_V2, false, 0, 0 }, { RELAY_V3, false, 0, 0 }, { RELAY_PUMP, false, 0, 0 } };
static uint32_t g_valveChangeMs[3] = { 0, 0, 0 };
static uint32_t g_pumpChangeMs = 0;

// Called as the very first thing in setup(): all relays OFF before anything else runs.
// Core 3.x ignores digitalWrite() before pinMode(), so the output latch is preloaded with the IDF call.
void relaysSafeInit() {
  for (uint8_t i = 0; i < 4; i++) {
    gpio_set_level((gpio_num_t)RELAY_PINS[i], 1);   // active-low: 1 = relay off
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], HIGH);
  }
}

void relaysInit() { LOG("RELAY", "safe init: V1 V2 V3 PUMP all OFF"); }

static void relayWrite(uint8_t idx, bool on) {
  g_relay[idx].on = on;
  digitalWrite(g_relay[idx].pin, on ? LOW : HIGH);
  if (idx < 3) g_valveChangeMs[idx] = millis(); else g_pumpChangeMs = millis();
}

bool relaysValveOn(uint8_t b)  { return (b >= 1 && b <= 3) ? g_relay[b - 1].on : false; }
bool relaysPumpOn()            { return g_relay[3].on; }
bool relaysAnyValveOpen()      { return g_relay[0].on || g_relay[1].on || g_relay[2].on; }
// Time of the last change that affects branch b: its own valve or the pump. Used by the leak "settle" gate.
uint32_t relaysLastChangeMs(uint8_t b) {
  uint32_t v = (b >= 1 && b <= 3) ? g_valveChangeMs[b - 1] : 0;
  return v > g_pumpChangeMs ? v : g_pumpChangeMs;
}

// Turn the pump off from any path (watchdog, interlock, leak logic, command).
void relaysPumpOff(Src src, Reason reason) {
  if (!g_relay[3].on) return;
  relayWrite(3, false);
  LOG("RELAY", "PUMP OFF src=%s%s%s", SRC_NAMES[src], reason ? " reason=" : "", REASON_NAMES[reason]);
  evtPost(EV_PUMP, 0, src, LK_NONE, -1.0f, 0, reason);
}

// Valve b (1..3) open/close. durS = 0 means the default cap. Returns false + err when refused.
bool relaysValveSet(uint8_t b, bool on, uint16_t durS, Src src, Err* err) {
  if (b < 1 || b > 3) { if (err) *err = ERR_BAD_BRANCH; return false; }
  uint8_t i = b - 1;
  if (on) {
    uint32_t cap = (durS == 0 || durS > VALVE_MAX_ON_S) ? VALVE_MAX_ON_S : durS;
    relayWrite(i, true);                       // re-issuing ON re-arms the timer
    g_relay[i].onSinceMs = millis();
    g_relay[i].maxOnMs = cap * 1000UL;
    LOG("RELAY", "V%u ON src=%s maxOn=%lus", b, SRC_NAMES[src], (unsigned long)cap);
    evtPost(EV_VALVE, b, src, LK_NONE, -1.0f, 1);
  } else {
    if (g_relay[i].on) {
      relayWrite(i, false);
      LOG("RELAY", "V%u OFF src=%s", b, SRC_NAMES[src]);
      evtPost(EV_VALVE, b, src, LK_NONE, -1.0f, 0);
    }
#if AUTO_PUMP_OFF_WHEN_ALL_CLOSED
    if (g_relay[3].on && !relaysAnyValveOpen()) relaysPumpOff(SRC_INTERLOCK, RSN_ALL_CLOSED);
#endif
  }
  if (err) *err = ERR_NONE;
  return true;
}

// Pump on/off. durS = 0 means PUMP_DEFAULT_ON_S; anything above PUMP_MAX_ON_S is capped.
bool relaysPumpSet(bool on, uint16_t durS, Src src, Err* err) {
  if (!on) { relaysPumpOff(src, RSN_NONE); if (err) *err = ERR_NONE; return true; }
#if PUMP_NEEDS_OPEN_VALVE
  if (!relaysAnyValveOpen()) { if (err) *err = ERR_NO_OPEN_VALVE; return false; }
#endif
  uint32_t cap = durS == 0 ? PUMP_DEFAULT_ON_S : (durS > PUMP_MAX_ON_S ? PUMP_MAX_ON_S : durS);
  relayWrite(3, true);
  g_relay[3].onSinceMs = millis();
  g_relay[3].maxOnMs = cap * 1000UL;
  LOG("RELAY", "PUMP ON src=%s maxOn=%lus", SRC_NAMES[src], (unsigned long)cap);
  evtPost(EV_PUMP, 0, src, LK_NONE, -1.0f, 1);
  if (err) *err = ERR_NONE;
  return true;
}

// Emergency stop: everything off immediately, one "all_off" event.
void relaysAllOff(Src src) {
  for (uint8_t i = 0; i < 4; i++) if (g_relay[i].on) relayWrite(i, false);
  LOG("RELAY", "ALL OFF src=%s", SRC_NAMES[src]);
  evtPost(EV_ALL_OFF, 0, src);
}

// Called every RELAY_TICK_MS from loop(): enforce the maximum on-times.
void relaysTick(uint32_t now) {
  for (uint8_t i = 0; i < 3; i++) {
    if (g_relay[i].on && now - g_relay[i].onSinceMs >= g_relay[i].maxOnMs) {
      relayWrite(i, false);
      LOG("SAFE", "V%u auto-off after %lus src=wd reason=max_on", i + 1, (unsigned long)(g_relay[i].maxOnMs / 1000));
      evtPost(EV_VALVE, i + 1, SRC_WD, LK_NONE, -1.0f, 0, RSN_MAX_ON);
#if AUTO_PUMP_OFF_WHEN_ALL_CLOSED
      if (g_relay[3].on && !relaysAnyValveOpen()) relaysPumpOff(SRC_INTERLOCK, RSN_ALL_CLOSED);
#endif
    }
  }
  if (g_relay[3].on && now - g_relay[3].onSinceMs >= g_relay[3].maxOnMs) {
    LOG("SAFE", "PUMP auto-off after %lus", (unsigned long)(g_relay[3].maxOnMs / 1000));
    relaysPumpOff(SRC_WD, RSN_MAX_ON);
  }
}
