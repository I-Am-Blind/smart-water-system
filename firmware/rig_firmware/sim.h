// sim.h - fake flow so the web/mobile UI can be built and demoed with no water.
// When on, the flow module reads simulated pulse counts instead of the interrupt counters,
// and the ADC values are replaced by plausible numbers. Relays still switch for real.
// Off at every boot; never persisted.
#pragma once
#include <Arduino.h>
#include "esp_random.h"
#include "config.h"
#include "log.h"
#include "state.h"
#include "relays.h"

static bool     g_simOn = false;
static float    g_simBase = SIM_BASE_LPM;
static float    g_simLeakPct[3] = { 0, 0, 0 };
static float    g_simMleakPct = 0;
static float    g_simTail[3] = { 0, 0, 0 };      // flow decays over ~2 s after a valve/pump closes
static float    g_simAcc[7] = { 0, 0, 0, 0, 0, 0, 0 }; // fractional pulses carried between ticks
static uint32_t g_simPulse[7] = { 0, 0, 0, 0, 0, 0, 0 };

bool simActive() { return g_simOn; }

// +/- pct percent of noise, e.g. noise(3) = 0.97 .. 1.03
static float simNoise(float pct) {
  return 1.0f + ((float)(esp_random() % 2001) / 1000.0f - 1.0f) * (pct / 100.0f);
}

// Advance the model by dtMs and add pulses to the simulated counters.
void simStep(uint32_t dtMs) {
  float dt = dtMs / 1000.0f;
  float lpm[7] = { 0, 0, 0, 0, 0, 0, 0 };
  float sumIn = 0;
  for (uint8_t b = 0; b < 3; b++) {
    float target = (relaysPumpOn() && relaysValveOn(b + 1)) ? g_simBase : 0.0f;
    if (target > 0) g_simTail[b] = target; else g_simTail[b] *= 0.35f;   // exponential tail
    if (g_simTail[b] < 0.02f) g_simTail[b] = 0;
    float in  = g_simTail[b] * simNoise(3);
    float out = in * (1.0f - g_simLeakPct[b] / 100.0f) * simNoise(3);
    lpm[1 + 2 * b] = in;
    lpm[2 + 2 * b] = out;
    sumIn += in;
  }
  lpm[0] = (g_simMleakPct < 99.0f ? sumIn / (1.0f - g_simMleakPct / 100.0f) : sumIn) * simNoise(2);
  for (uint8_t i = 0; i < 7; i++) {
    g_simAcc[i] += lpm[i] * FLOW_HZ_PER_LPM * dt;
    uint32_t whole = (uint32_t)g_simAcc[i];
    g_simPulse[i] += whole;
    g_simAcc[i] -= whole;
  }
}

uint32_t simPulses(uint8_t i) { return g_simPulse[i]; }

void simAdc(int* turbMv, int* tdsMv) {
  *turbMv = 2450 + (int)(esp_random() % 61) - 30;
  *tdsMv  = 420 + (int)(esp_random() % 21) - 10;
}

void simSet(bool on, Src src) {
  if (on == g_simOn) return;
  g_simOn = on;
  if (on) { for (uint8_t i = 0; i < 7; i++) { g_simPulse[i] = 0; g_simAcc[i] = 0; } }
  LOG("SIM", "%s base=%.2f L/min", on ? "on" : "off", g_simBase);
  evtPost(EV_SIM, 0, src, LK_NONE, -1.0f, on ? 1 : 0);
}

void simLeak(uint8_t b, float pct) {
  if (b < 1 || b > 3) return;
  g_simLeakPct[b - 1] = pct < 0 ? 0 : (pct > 100 ? 100 : pct);
  LOG("SIM", "branch %u loss=%.0f%%", b, g_simLeakPct[b - 1]);
}
void simMleak(float pct) { g_simMleakPct = pct < 0 ? 0 : (pct > 90 ? 90 : pct); LOG("SIM", "manifold loss=%.0f%%", g_simMleakPct); }
void simFlow(float lpm)  { g_simBase = lpm < 0 ? 0 : lpm; LOG("SIM", "base flow=%.2f L/min", g_simBase); }
void simClear()          { g_simLeakPct[0] = g_simLeakPct[1] = g_simLeakPct[2] = 0; g_simMleakPct = 0; LOG("SIM", "leaks cleared"); }
