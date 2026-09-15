// leak.h - the brain: compares IN vs OUT flow per branch and isolates a leaking branch.
//   loss % = (in - out) / in * 100, computed on LEAK_WINDOW_S seconds of pulses.
//   A branch is only judged while its valve is open, water has settled, and IN >= LEAK_MIN_FLOW_LPM.
//   Loss above DRIP for DRIP_CONFIRM seconds (or above BURST for BURST_CONFIRM seconds) latches a leak:
//   the valve is closed and stays refused until "reset". A manifold leak (master >> sum of inflows) stops the pump.
#pragma once
#include <Arduino.h>
#include "config.h"
#include "log.h"
#include "state.h"
#include "relays.h"
#include "flow.h"

static uint8_t  g_leakLevel[3] = { 0, 0, 0 };   // 0 ok, 1 warn, 2 drip, 3 burst
static float    g_leakLoss[3]  = { 0, 0, 0 };   // last computed loss (0 when gated)
static uint16_t g_dripS[3] = { 0, 0, 0 }, g_burstS[3] = { 0, 0, 0 };
static uint8_t  g_mleak = 0;
static uint16_t g_manifoldS = 0;
static uint32_t g_faultLogMs[3] = { 0, 0, 0 };

void leakInit() {
  LOG("LEAK", "min=%.1fL/min warn=%.0f%% drip=%.0f%%/%us burst=%.0f%%/%us manifold=%.0f%%/%us",
      LEAK_MIN_FLOW_LPM, LEAK_WARN_PCT, LEAK_DRIP_PCT, (unsigned)LEAK_DRIP_CONFIRM_S,
      LEAK_BURST_PCT, (unsigned)LEAK_BURST_CONFIRM_S, MANIFOLD_LOSS_PCT, (unsigned)MANIFOLD_CONFIRM_S);
}

uint8_t leakLevel(uint8_t b)     { return (b >= 1 && b <= 3) ? g_leakLevel[b - 1] : 0; }
float   leakLoss(uint8_t b)      { return (b >= 1 && b <= 3) ? g_leakLoss[b - 1] : 0; }
uint8_t leakMleak()              { return g_mleak; }
bool    leakIsLatched(uint8_t b) { return leakLevel(b) >= 2; }

static void leakLatch(uint8_t b, LeakKind kind, float loss) {
  g_leakLevel[b - 1] = kind == LK_BURST ? 3 : 2;
  LOG("LEAK", "B%u %s loss=%.1f%% confirmed -> closing V%u", b, kind == LK_BURST ? "BURST" : "DRIP", loss, b);
  evtPost(EV_LEAK, b, SRC_LEAK, kind, loss);
  relaysValveSet(b, false, 0, SRC_LEAK, nullptr);
}

// Called once per second, right after flowSample().
void leakTick(uint32_t now) {
  bool settling[3];
  for (uint8_t b = 1; b <= 3; b++) {
    uint8_t i = b - 1;
    settling[i] = (now - relaysLastChangeMs(b)) < (uint32_t)LEAK_SETTLE_S * 1000UL;
    float in = flowWinLpm(1 + 2 * i), out = flowWinLpm(2 + 2 * i);
    bool gated = !relaysValveOn(b) || settling[i] || in < LEAK_MIN_FLOW_LPM;
    if (gated) {
      g_leakLoss[i] = 0; g_dripS[i] = 0; g_burstS[i] = 0;
      if (g_leakLevel[i] == 1) g_leakLevel[i] = 0;   // warn clears, latched stays
      continue;
    }
    float loss = (in - out) / in * 100.0f;
    g_leakLoss[i] = loss < 0 ? 0 : loss;
    if (loss <= SENSOR_FAULT_PCT && now - g_faultLogMs[i] > 30000) {
      g_faultLogMs[i] = now;
      LOG("LEAK", "B%u sensor mismatch: OUT %.2f > IN %.2f L/min (check wiring)", b, out, in);
    }
    if (g_leakLevel[i] >= 2) continue;              // already latched, valve is closed anyway
    if (loss >= LEAK_BURST_PCT)      { g_burstS[i]++; g_dripS[i]++; }
    else if (loss >= LEAK_DRIP_PCT)  { g_dripS[i]++; g_burstS[i] = 0; }
    else if (loss < LEAK_CLEAR_PCT)  { g_dripS[i] = 0; g_burstS[i] = 0; }
    // between CLEAR and DRIP: hold the counters (hysteresis)
    if (g_burstS[i] >= LEAK_BURST_CONFIRM_S)     leakLatch(b, LK_BURST, loss);
    else if (g_dripS[i] >= LEAK_DRIP_CONFIRM_S)  leakLatch(b, LK_DRIP, loss);
    else g_leakLevel[i] = loss >= LEAK_WARN_PCT ? 1 : 0;
  }

  // Manifold check: water entering the master sensor should reach the open branches.
  float master = flowWinLpm(0), sumIn = 0;
  bool anySettling = settling[0] || settling[1] || settling[2];
  for (uint8_t b = 1; b <= 3; b++) if (relaysValveOn(b)) sumIn += flowWinLpm(1 + 2 * (b - 1));
  if (g_mleak || anySettling || master < MANIFOLD_MIN_FLOW_LPM || !relaysPumpOn()) { g_manifoldS = 0; return; }
  float mloss = (master - sumIn) / master * 100.0f;
  if (mloss >= MANIFOLD_LOSS_PCT) {
    if (++g_manifoldS >= MANIFOLD_CONFIRM_S) {
      g_mleak = 1;
      LOG("LEAK", "MANIFOLD loss=%.1f%% confirmed -> pump OFF", mloss);
      evtPost(EV_MLEAK, 0, SRC_LEAK, LK_NONE, mloss, -1, RSN_MANIFOLD);
#if AUTO_PUMP_OFF_ON_MANIFOLD
      relaysPumpOff(SRC_LEAK, RSN_MANIFOLD);
#endif
    }
  } else {
    g_manifoldS = 0;
  }
}

// Clear latches only. Valves stay closed and the pump stays off until commanded again.
void leakReset(Src src) {
  for (uint8_t i = 0; i < 3; i++) { g_leakLevel[i] = 0; g_leakLoss[i] = 0; g_dripS[i] = 0; g_burstS[i] = 0; }
  g_mleak = 0; g_manifoldS = 0;
  LOG("LEAK", "reset src=%s", SRC_NAMES[src]);
  evtPost(EV_LEAK_CLEAR, 0, src);
}
