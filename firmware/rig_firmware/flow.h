// flow.h - pulse counting, L/min, calibration and the two analog sensors.
// Interrupt: one tiny IRAM function counts falling edges on all 7 pins (with a glitch filter).
// Once per second loop() reads the counters, computes L/min and keeps a LEAK_WINDOW_S sliding window.
#pragma once
#include <Arduino.h>
#include <Preferences.h>
#include "esp_timer.h"
#include "config.h"
#include "log.h"
#include "sim.h"

static volatile uint32_t g_pulse[7]  = { 0, 0, 0, 0, 0, 0, 0 };
static volatile uint32_t g_lastUs[7] = { 0, 0, 0, 0, 0, 0, 0 };

void IRAM_ATTR flowIsr(void* arg) {
  uint8_t i = (uint8_t)(uintptr_t)arg;
  uint32_t now = (uint32_t)esp_timer_get_time();
  if (now - g_lastUs[i] >= FLOW_GLITCH_US) { g_pulse[i] = g_pulse[i] + 1; g_lastUs[i] = now; }
}

static uint32_t g_prevCount[7] = { 0, 0, 0, 0, 0, 0, 0 };
static uint32_t g_rawCount[7]  = { 0, 0, 0, 0, 0, 0, 0 };   // latest cumulative count (real or sim)
static float    g_lpm[7]       = { 0, 0, 0, 0, 0, 0, 0 };   // last 1 s, calibrated
static uint32_t g_win[7][LEAK_WINDOW_S];                   // per-second deltas, ring buffer
static uint8_t  g_winIdx = 0;
static float    g_winLpm[7]    = { 0, 0, 0, 0, 0, 0, 0 };   // average over the window, calibrated
static float    g_cal[7]       = { 1, 1, 1, 1, 1, 1, 1 };   // multiplier per sensor (NVS)
static uint32_t g_lastSampleMs = 0;
static bool     g_lastSimState = false;

// Calibration run: 10 s with pump on, all valves open, no leak.
static bool     g_calRunning = false;
static uint8_t  g_calTicks = 0;
static uint32_t g_calSum[7];

void flowLoadCal() {
  Preferences p;
  if (!p.begin("rigcal", true)) return;
  char key[4] = "c0";
  for (uint8_t i = 0; i < 7; i++) { key[1] = '0' + i; g_cal[i] = p.getFloat(key, 1.0f); }
  p.end();
}

void flowInit() {
  for (uint8_t i = 0; i < 7; i++) {
    pinMode(FLOW_PINS[i], INPUT);   // lines are driven by the 10k/20k dividers, no internal pull
    attachInterruptArg(digitalPinToInterrupt(FLOW_PINS[i]), flowIsr, (void*)(uintptr_t)i, FALLING);
  }
  for (uint8_t i = 0; i < 7; i++) for (uint8_t k = 0; k < LEAK_WINDOW_S; k++) g_win[i][k] = 0;
  flowLoadCal();
  g_lastSampleMs = millis();
  LOG("FLOW", "isr attached x7 glitch=%uus window=%us", (unsigned)FLOW_GLITCH_US, (unsigned)LEAK_WINDOW_S);
}

// Called once per SAMPLE_MS from loop().
void flowSample(uint32_t now) {
  uint32_t dtMs = now - g_lastSampleMs;
  if (dtMs == 0) dtMs = 1;
  g_lastSampleMs = now;
  if (simActive()) simStep(dtMs);
  bool resync = simActive() != g_lastSimState;   // source of pulses changed: skip this second's delta
  g_lastSimState = simActive();
  for (uint8_t i = 0; i < 7; i++) {
    uint32_t c = simActive() ? simPulses(i) : g_pulse[i];
    uint32_t delta = c - g_prevCount[i];
    if (resync || c < g_prevCount[i]) delta = 0;
    g_prevCount[i] = c;
    g_rawCount[i] = c;
    g_win[i][g_winIdx] = delta;
    g_lpm[i] = (float)delta * (1000.0f / (float)dtMs) / FLOW_HZ_PER_LPM * g_cal[i];
    uint32_t sum = 0;
    for (uint8_t k = 0; k < LEAK_WINDOW_S; k++) sum += g_win[i][k];
    g_winLpm[i] = (float)sum / (float)LEAK_WINDOW_S / FLOW_HZ_PER_LPM * g_cal[i];
    if (g_calRunning) g_calSum[i] += delta;
  }
  g_winIdx = (g_winIdx + 1) % LEAK_WINDOW_S;
  if (g_calRunning && ++g_calTicks >= 10) {
    g_calRunning = false;
    Preferences p;
    p.begin("rigcal", false);
    char key[4] = "c0";
    uint32_t sumIn = 0;
    for (uint8_t b = 0; b < 3; b++) {
      uint32_t in = g_calSum[1 + 2 * b], out = g_calSum[2 + 2 * b];
      float f = (in > 100 && out > 100) ? (float)in / (float)out : 1.0f;
      if (f < 0.8f) f = 0.8f;
      if (f > 1.25f) f = 1.25f;
      g_cal[2 + 2 * b] = f;
      key[1] = '0' + (2 + 2 * b); p.putFloat(key, f);
      sumIn += in;
    }
    float fm = (sumIn > 300 && g_calSum[0] > 300) ? (float)sumIn / (float)g_calSum[0] : 1.0f;
    if (fm < 0.8f) fm = 0.8f;
    if (fm > 1.25f) fm = 1.25f;
    g_cal[0] = fm; p.putFloat("c0", fm);
    p.end();
    LOG("CAL", "done: m=%.3f b1o=%.3f b2o=%.3f b3o=%.3f", g_cal[0], g_cal[2], g_cal[4], g_cal[6]);
  }
}

float    flowLpm(uint8_t i)    { return g_lpm[i]; }
float    flowWinLpm(uint8_t i) { return g_winLpm[i]; }
uint32_t flowRaw(uint8_t i)    { return g_rawCount[i]; }

void flowCalStart() {
  if (!relaysPumpOn() || !(relaysValveOn(1) && relaysValveOn(2) && relaysValveOn(3))) {
    LOG("CAL", "refused: pump must be on and all valves open (no leak)");
    return;
  }
  for (uint8_t i = 0; i < 7; i++) g_calSum[i] = 0;
  g_calTicks = 0; g_calRunning = true;
  LOG("CAL", "running for 10 s, keep the water flowing");
}
void flowCalClear() {
  Preferences p; p.begin("rigcal", false); p.clear(); p.end();
  for (uint8_t i = 0; i < 7; i++) g_cal[i] = 1.0f;
  LOG("CAL", "cleared, all factors = 1.000");
}
void flowCalShow() {
  LOG("CAL", "factors m=%.3f b1i=%.3f b1o=%.3f b2i=%.3f b2o=%.3f b3i=%.3f b3o=%.3f",
      g_cal[0], g_cal[1], g_cal[2], g_cal[3], g_cal[4], g_cal[5], g_cal[6]);
}

// ---------------------------------------------------------------- analog sensors
void sensorsInit() {
  analogReadResolution(12);
  analogSetPinAttenuation(TURBIDITY_PIN, ADC_11db);
  analogSetPinAttenuation(TDS_PIN, ADC_11db);
}

static int adcAvgMv(uint8_t pin) {
  uint32_t sum = 0;
  for (uint8_t k = 0; k < ADC_SAMPLES; k++) sum += analogReadMilliVolts(pin);
  return (int)(sum / ADC_SAMPLES);
}

// Turbidity module output falls as water gets cloudier (DFRobot curve, valid ~2.5..4.2 V).
static int turbidityNtu(int pinMv) {
  float v = pinMv * TURB_DIVIDER / 1000.0f;
  float ntu = -1120.4f * v * v + 5742.3f * v - 4352.9f;
  if (v > 4.2f) ntu = 0;
  if (ntu < 0) ntu = 0;
  if (ntu > 3000) ntu = 3000;
  return (int)ntu;
}

// Grove TDS: standard cubic fit, 25 C assumed (no temperature sensor on this rig).
static int tdsPpm(int pinMv) {
  float v = pinMv / 1000.0f;
  float ppm = (133.42f * v * v * v - 255.86f * v * v + 857.39f * v) * 0.5f;
  if (ppm < 0) ppm = 0;
  return (int)ppm;
}

void sensorsRead(int* turbMv, int* ntu, int* tdsMv, int* ppm) {
  if (simActive()) simAdc(turbMv, tdsMv);
  else { *turbMv = adcAvgMv(TURBIDITY_PIN); *tdsMv = adcAvgMv(TDS_PIN); }
  *ntu = turbidityNtu(*turbMv);
  *ppm = tdsPpm(*tdsMv);
}
