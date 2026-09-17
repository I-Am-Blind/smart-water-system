/*
 * ============================================================================
 *  rig_firmware - water-leak-detection rig (ESP32-S3-WROOM-1 N16R8)
 * ============================================================================
 *
 *  THE RIG
 *    Two lanes fed by one pump. Only lane 1 has working flow sensors, so only
 *    lane 1 can be judged for leaks; lane 2 is a plain solenoid that the
 *    operator - or an automatic failover - opens and closes.
 *
 *      branch 1  "monitored"  valve V1 + IN and OUT flow sensors  -> leak detection
 *      branch 2  "backup"     valve V2, no sensors                -> opened on failover
 *
 *    Leak on branch 1  =>  close V1, wait 300 ms, open V2, latch.
 *    The latch refuses "valve 1 on" until "reset" (serial) / reset_leak (server).
 *    All of that happens on the board: no Wi-Fi, no server, no laptop needed.
 *
 *  WIRING
 *    Flow IN   (branch 1)  GPIO16      YF-S401, open collector, via 10k/20k divider
 *    Flow OUT  (branch 1)  GPIO17      YF-S401, same
 *    Turbidity             GPIO8       analog, via 10k/20k divider (pin sees 2/3 of Vout)
 *    TDS (Grove)           GPIO9       analog, direct, max ~2.3 V
 *    Relay V1  branch 1    GPIO11      ACTIVE LOW: LOW = energised = valve OPEN
 *    Relay V2  branch 2    GPIO12      ACTIVE LOW
 *    Relay PUMP            GPIO14      ACTIVE LOW
 *    Relay ch 4            GPIO13      unused
 *    Never use: 0,3,45,46 (strapping) 19,20 (USB) 26-32 (flash) 35,36,37 (PSRAM) 43,44 (UART0)
 *
 *  ARDUINO IDE
 *    Board "ESP32S3 Dev Module", USB CDC On Boot: Enabled, Flash QIO 80 MHz / 16 MB,
 *    PSRAM: OPI PSRAM, Partition Scheme: Huge APP.
 *    Libraries: ArduinoJson 7.x, WebSockets 2.7.x (Markus Sattler).
 *
 *  FIRST RUN (serial, 115200, both the USB port and the UART0 pins)
 *    ssid=YourNetwork
 *    pass=YourPassword
 *    server=ws://192.168.0.8:3000/ws        (or ws://your-laptop.local:3000/ws)
 *    Type "help" for everything else. "!" switches every relay off instantly.
 *    If the Wi-Fi cannot be joined within 30 s the rig starts its own access point
 *    (SSID = the device id, e.g. "rig-7a3f21") and dials ws://192.168.4.2:3000/ws,
 *    which is the first address its DHCP server hands out - join it from the laptop.
 *
 *  Wire format: docs/PROTOCOL.md. Setup and the bench test: firmware/README.md.
 * ============================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <stdarg.h>
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_mac.h"
#include "driver/gpio.h"
#include "branding.h"

#define FW_VERSION "2.0.0"

// ============================================================================
// CONFIG - the only block you should need to edit
// ============================================================================

// ---- pins ----
#define F_IN            16    // branch 1 inlet flow sensor
#define F_OUT           17    // branch 1 outlet flow sensor
#define TURBIDITY_PIN   8     // ADC1
#define TDS_PIN         9     // ADC1 (ADC2 is unusable while Wi-Fi runs)
#define RELAY_V1        11    // branch 1 valve, active low
#define RELAY_V2        12    // branch 2 valve, active low
#define RELAY_PUMP      14    // pump, active low

// ---- relay safety ----
#define VALVE_MAX_ON_S              600   // a valve may stay open at most 10 min per command (coil heat)
#define PUMP_DEFAULT_ON_S           20    // pump on without a duration stops after 20 s
#define PUMP_MAX_ON_S               300   // longest pump run a single command may request
#define PUMP_NEEDS_OPEN_VALVE       1     // 1 = refuse to start the pump when both valves are closed
#define AUTO_PUMP_OFF_WHEN_ALL_CLOSED 1   // 1 = stop the pump when the last open valve closes
#define RELAY_TICK_MS               100   // how often the max-on timers are checked

// ---- flow measurement ----
#define FLOW_HZ_PER_LPM  98.0f   // YF-S401: pulses/s = 98 x L/min (5880 pulses per litre)
#define FLOW_CAL_OUT     1.000f  // trim if the OUT sensor reads high/low against IN with no leak
#define FLOW_GLITCH_US   500     // ignore edges closer than this (real max ~600 Hz = 1.7 ms period)
#define SAMPLE_MS        1000    // flow is evaluated once per second
#define ADC_SAMPLES      8       // analog reads averaged per sample
#define TURB_DIVIDER     1.5f    // multiply pin mV by this to get the sensor's own output voltage

// ---- leak detection (tune here) ----
#define LEAK_WINDOW_S          3      // seconds of pulses summed before comparing IN vs OUT
#define LEAK_MIN_FLOW_LPM      0.5f   // below this IN flow the sensors are too coarse to judge
#define LEAK_MIN_DELTA_PULSES  30     // IN-OUT must also differ by this many pulses per window
                                      // (the rule proven on the Arduino bench rig; ~0.10 L/min)
#define LEAK_WARN_PCT          12.0f  // loss above this shows as "warn" in the UI, no action
#define LEAK_DRIP_PCT          20.0f  // loss at/above this for DRIP_CONFIRM_S seconds = drip leak
#define LEAK_BURST_PCT         50.0f  // loss at/above this for BURST_CONFIRM_S seconds = burst leak
#define LEAK_CLEAR_PCT         10.0f  // counters only reset below this (hysteresis)
#define LEAK_DRIP_CONFIRM_S    5
#define LEAK_BURST_CONFIRM_S   2
#define LEAK_SETTLE_S          4      // ignore the branch this long after a valve/pump change
#define SENSOR_FAULT_PCT      -20.0f  // OUT exceeding IN by this much = wiring problem, log only
#define FAILOVER_ON_LEAK       1      // 1 = open the backup valve when the monitored lane latches
#define FAILOVER_BREAK_MS      300    // break-before-make pause between closing V1 and opening V2

// ---- network (defaults; override over serial, stored in NVS) ----
#define DEFAULT_WIFI_SSID  ""
#define DEFAULT_WIFI_PASS  ""
#define DEFAULT_SERVER_URL "ws://192.168.0.8:3000/ws"
#define AP_FALLBACK_S      30     // no Wi-Fi for this long after boot -> start our own AP
#define AP_PASS            "cascade2026"   // "" = open network; must be 8+ chars otherwise
#define AP_SERVER_URL      "ws://192.168.4.2:3000/ws"   // first DHCP lease our AP hands out
#define WIFI_BACKSTOP_S    60     // if not connected for this long, call WiFi.begin() again
#define WS_RECONNECT_MIN_MS 2000
#define WS_RECONNECT_MAX_MS 30000
#define WS_PING_MS         15000
#define WS_PONG_TIMEOUT_MS 3000
#define WS_PONG_MISSES     2
#define TEL_PERIOD_MS      1000   // telemetry rate
#define NET_TASK_STACK     16384  // bytes; TLS + JSON need room
#define NET_TASK_CORE      0      // Wi-Fi/lwIP already run on core 0; loop() runs on core 1

#define NB 2   // branches
#define NS 2   // flow sensors: [b1 in, b1 out]

// ============================================================================
// SHARED STATE - loop() on core 1 owns the rig; netTask on core 0 owns the radio.
// Commands flow net -> loop through g_cmdQ; acks and events flow back the other way.
// ============================================================================

// Names must match docs/PROTOCOL.md.
enum Act : uint8_t { ACT_VALVE, ACT_PUMP, ACT_ALL_OFF, ACT_RESET_LEAK, ACT_PING, ACT_UNKNOWN };
enum Src : uint8_t { SRC_SERIAL, SRC_WS, SRC_LEAK, SRC_WD, SRC_INTERLOCK, SRC_BOOT };
enum EvKind : uint8_t { EV_BOOT, EV_LEAK, EV_LEAK_CLEAR, EV_VALVE, EV_PUMP, EV_ALL_OFF };
enum Reason : uint8_t { RSN_NONE, RSN_MAX_ON, RSN_ALL_CLOSED, RSN_FAILOVER };
enum Err : uint8_t { ERR_NONE, ERR_LATCHED, ERR_BAD_BRANCH, ERR_NO_OPEN_VALVE, ERR_UNKNOWN_ACT, ERR_BAD_JSON };
enum LeakKind : uint8_t { LK_NONE, LK_DRIP, LK_BURST };

static const char* const SRC_NAMES[]    = { "serial", "ws", "leak", "wd", "interlock", "boot" };
static const char* const EV_NAMES[]     = { "boot", "leak", "leak_clear", "valve", "pump", "all_off" };
static const char* const REASON_NAMES[] = { "", "max_on", "all_closed", "failover" };
static const char* const ERR_NAMES[]    = { "", "latched", "bad_branch", "no_open_valve", "unknown_act", "bad_json" };
static const char* const KIND_NAMES[]   = { "", "drip", "burst" };

struct Cmd {                 // a command waiting to be applied by loop()
  uint32_t id;               // echoed in the ack (0 for serial)
  Act      act;
  uint8_t  b;                // branch 1..2 (0 = none)
  bool     hasOn;
  bool     on;
  uint16_t dur;              // seconds, 0 = default
  Src      src;
};

struct AckMsg {              // result of a command, sent back to whoever asked
  uint32_t id;
  bool     ok;
  Err      err;
  uint32_t ms;               // millis() at execution
  Src      src;
};

struct Evt {                 // something happened; becomes an "evt" JSON
  uint32_t ms;
  EvKind   ev;
  uint8_t  b;                // 0 = none
  LeakKind kind;
  float    loss;             // percent, <0 = none
  int8_t   on;               // -1 = none, 0/1 = new state
  Src      src;
  Reason   reason;
};

// Settings, stored in NVS. Declared up here because the .ino preprocessor hoists
// function prototypes above every definition that follows the first function.
struct NetCfg { char ssid[33]; char pass[65]; char server[128]; char name[25]; };

struct Snapshot {            // everything the outside world sees, published once per second
  uint32_t ms, seq;
  float    lpm[NS];
  uint32_t pulses[NS];
  float    loss[NB];         // branch 2 is never sensed: always 0
  uint8_t  leak[NB];         // 0 ok, 1 warn, 2 drip, 3 burst
  uint8_t  valve[NB];
  uint8_t  pump;
  int      turbMv, ntu, tdsMv, ppm;
};

static portMUX_TYPE  g_mux = portMUX_INITIALIZER_UNLOCKED;
static Snapshot      g_snap = {};
static QueueHandle_t g_cmdQ = nullptr;   // net -> loop
static QueueHandle_t g_ackQ = nullptr;   // loop -> net
static QueueHandle_t g_evtQ = nullptr;   // loop -> net
static volatile uint32_t g_cfgVersion = 0;   // bumped by the console when settings change

AckMsg applyCmd(const Cmd& c);           // defined at the bottom

static void snapshotPublish(const Snapshot& s) {
  taskENTER_CRITICAL(&g_mux); g_snap = s; taskEXIT_CRITICAL(&g_mux);
}
static void snapshotCopy(Snapshot& out) {
  taskENTER_CRITICAL(&g_mux); out = g_snap; taskEXIT_CRITICAL(&g_mux);
}

// Post an event; never blocks. A dropped event is harmless: the next tel carries full state.
static void evtPost(EvKind ev, uint8_t b, Src src, LeakKind kind = LK_NONE, float loss = -1.0f,
                    int8_t on = -1, Reason reason = RSN_NONE) {
  Evt e = {};
  e.ms = millis(); e.ev = ev; e.b = b; e.kind = kind; e.loss = loss; e.on = on; e.src = src; e.reason = reason;
  if (g_evtQ) xQueueSend(g_evtQ, &e, 0);
}
static bool cmdPost(const Cmd& c)    { return g_cmdQ && xQueueSend(g_cmdQ, &c, 0) == pdTRUE; }
static bool ackPost(const AckMsg& a) { return g_ackQ && xQueueSend(g_ackQ, &a, 0) == pdTRUE; }

// ============================================================================
// LOG - every line is  [12345][TAG] message  on both serial ports
// ============================================================================

static SemaphoreHandle_t g_logMutex = nullptr;

static void logBegin() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);     // never block if no USB host is reading
  Serial0.begin(115200);
  g_logMutex = xSemaphoreCreateMutex();
}

static void logPrintf(const char* tag, const char* fmt, ...) {
  char line[176];
  int n = snprintf(line, sizeof line, "[%lu][%s] ", millis(), tag);
  if (n < 0) return;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(line + n, sizeof line - n, fmt, ap);
  va_end(ap);
  bool locked = g_logMutex && xSemaphoreTake(g_logMutex, pdMS_TO_TICKS(10)) == pdTRUE;
  Serial.println(line);
  Serial0.println(line);
  if (locked) xSemaphoreGive(g_logMutex);
}

#define LOG(tag, ...) logPrintf(tag, __VA_ARGS__)

// ============================================================================
// RELAYS - the only code that writes to the relay pins.
// Nothing energises on boot; every ON has a maximum on-time; the pump is
// interlocked with the valves; every change is logged and sent as an "evt".
// ============================================================================

static const uint8_t RELAY_PINS[3] = { RELAY_V1, RELAY_V2, RELAY_PUMP };   // index 0,1 = valves, 2 = pump
#define R_PUMP 2

struct Relay { bool on; uint32_t onSinceMs; uint32_t maxOnMs; };
static Relay   g_relay[3] = {};
static uint32_t g_valveChangeMs[NB] = { 0, 0 };
static uint32_t g_pumpChangeMs = 0;
static bool     g_holdInterlock = false;   // true during a failover: both valves are briefly closed

// Called as the very first thing in setup(): all relays OFF before anything else runs.
// Core 3.x ignores digitalWrite() before pinMode(), so the latch is preloaded with the IDF call.
static void relaysSafeInit() {
  for (uint8_t i = 0; i < 3; i++) {
    gpio_set_level((gpio_num_t)RELAY_PINS[i], 1);   // active low: 1 = relay off
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], HIGH);
  }
}

static void relayWrite(uint8_t idx, bool on) {
  g_relay[idx].on = on;
  digitalWrite(RELAY_PINS[idx], on ? LOW : HIGH);
  if (idx < NB) g_valveChangeMs[idx] = millis(); else g_pumpChangeMs = millis();
}

static bool relaysValveOn(uint8_t b)  { return (b >= 1 && b <= NB) ? g_relay[b - 1].on : false; }
static bool relaysPumpOn()            { return g_relay[R_PUMP].on; }
static bool relaysAnyValveOpen()      { return g_relay[0].on || g_relay[1].on; }

// Time of the last change that affects branch b: its own valve or the pump. Used by the settle gate.
static uint32_t relaysLastChangeMs(uint8_t b) {
  uint32_t v = (b >= 1 && b <= NB) ? g_valveChangeMs[b - 1] : 0;
  return v > g_pumpChangeMs ? v : g_pumpChangeMs;
}

static void relaysPumpOff(Src src, Reason reason) {
  if (!g_relay[R_PUMP].on) return;
  relayWrite(R_PUMP, false);
  LOG("RELAY", "PUMP OFF src=%s%s%s", SRC_NAMES[src], reason ? " reason=" : "", REASON_NAMES[reason]);
  evtPost(EV_PUMP, 0, src, LK_NONE, -1.0f, 0, reason);
}

// Stop the pump if nothing is open any more (skipped while a failover is mid-swap).
static void pumpInterlock() {
#if AUTO_PUMP_OFF_WHEN_ALL_CLOSED
  if (!g_holdInterlock && g_relay[R_PUMP].on && !relaysAnyValveOpen())
    relaysPumpOff(SRC_INTERLOCK, RSN_ALL_CLOSED);
#endif
}

// Valve b (1..NB) open/close. durS = 0 means the default cap. Returns false + err when refused.
static bool relaysValveSet(uint8_t b, bool on, uint16_t durS, Src src, Err* err, Reason reason = RSN_NONE) {
  if (b < 1 || b > NB) { if (err) *err = ERR_BAD_BRANCH; return false; }
  uint8_t i = b - 1;
  if (on) {
    uint32_t cap = (durS == 0 || durS > VALVE_MAX_ON_S) ? VALVE_MAX_ON_S : durS;
    relayWrite(i, true);                       // re-issuing ON re-arms the timer
    g_relay[i].onSinceMs = millis();
    g_relay[i].maxOnMs = cap * 1000UL;
    LOG("RELAY", "V%u ON src=%s maxOn=%lus%s%s", b, SRC_NAMES[src], (unsigned long)cap,
        reason ? " reason=" : "", REASON_NAMES[reason]);
    evtPost(EV_VALVE, b, src, LK_NONE, -1.0f, 1, reason);
  } else {
    if (g_relay[i].on) {
      relayWrite(i, false);
      LOG("RELAY", "V%u OFF src=%s", b, SRC_NAMES[src]);
      evtPost(EV_VALVE, b, src, LK_NONE, -1.0f, 0, reason);
    }
    pumpInterlock();
  }
  if (err) *err = ERR_NONE;
  return true;
}

// Pump on/off. durS = 0 means PUMP_DEFAULT_ON_S; anything above PUMP_MAX_ON_S is capped.
static bool relaysPumpSet(bool on, uint16_t durS, Src src, Err* err) {
  if (!on) { relaysPumpOff(src, RSN_NONE); if (err) *err = ERR_NONE; return true; }
#if PUMP_NEEDS_OPEN_VALVE
  if (!relaysAnyValveOpen()) { if (err) *err = ERR_NO_OPEN_VALVE; return false; }
#endif
  uint32_t cap = durS == 0 ? PUMP_DEFAULT_ON_S : (durS > PUMP_MAX_ON_S ? PUMP_MAX_ON_S : durS);
  relayWrite(R_PUMP, true);
  g_relay[R_PUMP].onSinceMs = millis();
  g_relay[R_PUMP].maxOnMs = cap * 1000UL;
  LOG("RELAY", "PUMP ON src=%s maxOn=%lus", SRC_NAMES[src], (unsigned long)cap);
  evtPost(EV_PUMP, 0, src, LK_NONE, -1.0f, 1);
  if (err) *err = ERR_NONE;
  return true;
}

// Emergency stop: everything off immediately, one "all_off" event.
static void relaysAllOff(Src src) {
  for (uint8_t i = 0; i < 3; i++) if (g_relay[i].on) relayWrite(i, false);
  LOG("RELAY", "ALL OFF src=%s", SRC_NAMES[src]);
  evtPost(EV_ALL_OFF, 0, src);
}

// Called every RELAY_TICK_MS from loop(): enforce the maximum on-times.
static void relaysTick(uint32_t now) {
  for (uint8_t i = 0; i < NB; i++) {
    if (g_relay[i].on && now - g_relay[i].onSinceMs >= g_relay[i].maxOnMs) {
      relayWrite(i, false);
      LOG("SAFE", "V%u auto-off after %lus src=wd reason=max_on", i + 1, (unsigned long)(g_relay[i].maxOnMs / 1000));
      evtPost(EV_VALVE, i + 1, SRC_WD, LK_NONE, -1.0f, 0, RSN_MAX_ON);
      pumpInterlock();
    }
  }
  if (g_relay[R_PUMP].on && now - g_relay[R_PUMP].onSinceMs >= g_relay[R_PUMP].maxOnMs) {
    LOG("SAFE", "PUMP auto-off after %lus", (unsigned long)(g_relay[R_PUMP].maxOnMs / 1000));
    relaysPumpOff(SRC_WD, RSN_MAX_ON);
  }
}

// ============================================================================
// FLOW + ANALOG SENSORS
// One IRAM interrupt counts falling edges on both pins (with a glitch filter).
// Once per second loop() turns the counters into L/min and keeps a LEAK_WINDOW_S window.
// ============================================================================

static volatile uint32_t g_pulse[NS]  = { 0, 0 };
static volatile uint32_t g_lastUs[NS] = { 0, 0 };

static void IRAM_ATTR flowIsr(void* arg) {
  uint8_t i = (uint8_t)(uintptr_t)arg;
  uint32_t now = (uint32_t)esp_timer_get_time();
  if (now - g_lastUs[i] >= FLOW_GLITCH_US) { g_pulse[i] = g_pulse[i] + 1; g_lastUs[i] = now; }
}

static const uint8_t FLOW_PINS[NS] = { F_IN, F_OUT };
static const float   FLOW_CAL[NS]  = { 1.0f, FLOW_CAL_OUT };
static uint32_t g_prevCount[NS] = { 0, 0 };
static uint32_t g_rawCount[NS]  = { 0, 0 };          // cumulative, reported as "p"
static float    g_lpm[NS]       = { 0, 0 };          // last second
static uint32_t g_win[NS][LEAK_WINDOW_S];            // per-second pulse deltas, ring buffer
static uint32_t g_winSum[NS]    = { 0, 0 };          // pulses over the whole window
static float    g_winLpm[NS]    = { 0, 0 };          // average L/min over the window
static uint8_t  g_winIdx = 0;
static uint32_t g_lastSampleMs = 0;

static void flowInit() {
  for (uint8_t i = 0; i < NS; i++) {
    pinMode(FLOW_PINS[i], INPUT);   // lines are driven by the 10k/20k dividers, no internal pull
    attachInterruptArg(digitalPinToInterrupt(FLOW_PINS[i]), flowIsr, (void*)(uintptr_t)i, FALLING);
    for (uint8_t k = 0; k < LEAK_WINDOW_S; k++) g_win[i][k] = 0;
  }
  g_lastSampleMs = millis();
  LOG("FLOW", "isr on GPIO%u(in) GPIO%u(out) glitch=%uus window=%us",
      (unsigned)F_IN, (unsigned)F_OUT, (unsigned)FLOW_GLITCH_US, (unsigned)LEAK_WINDOW_S);
}

static void flowSample(uint32_t now) {
  uint32_t dtMs = now - g_lastSampleMs;
  if (dtMs == 0) dtMs = 1;
  g_lastSampleMs = now;
  for (uint8_t i = 0; i < NS; i++) {
    uint32_t c = g_pulse[i];
    uint32_t delta = c >= g_prevCount[i] ? c - g_prevCount[i] : 0;
    g_prevCount[i] = c;
    g_rawCount[i] = c;
    g_win[i][g_winIdx] = delta;
    g_lpm[i] = (float)delta * (1000.0f / (float)dtMs) / FLOW_HZ_PER_LPM * FLOW_CAL[i];
    uint32_t sum = 0;
    for (uint8_t k = 0; k < LEAK_WINDOW_S; k++) sum += g_win[i][k];
    g_winSum[i] = sum;
    g_winLpm[i] = (float)sum / (float)LEAK_WINDOW_S / FLOW_HZ_PER_LPM * FLOW_CAL[i];
  }
  g_winIdx = (g_winIdx + 1) % LEAK_WINDOW_S;
}

static void sensorsInit() {
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
  return ppm < 0 ? 0 : (int)ppm;
}

static void sensorsRead(int* turbMv, int* ntu, int* tdsMv, int* ppm) {
  *turbMv = adcAvgMv(TURBIDITY_PIN);
  *tdsMv  = adcAvgMv(TDS_PIN);
  *ntu = turbidityNtu(*turbMv);
  *ppm = tdsPpm(*tdsMv);
}

// ============================================================================
// LEAK - compares branch 1's IN and OUT flow and isolates the lane.
//   loss % = (in - out) / in * 100 over LEAK_WINDOW_S seconds, and the raw pulse
//   difference must also clear LEAK_MIN_DELTA_PULSES so sensor jitter cannot trip it.
//   Judged only while V1 is open, water has settled, and IN >= LEAK_MIN_FLOW_LPM.
// ============================================================================

static uint8_t  g_leakLevel = 0;    // 0 ok, 1 warn, 2 drip, 3 burst  (branch 1 only)
static float    g_leakLoss  = 0;    // last computed loss (0 when gated)
static uint16_t g_dripS = 0, g_burstS = 0;
static uint32_t g_faultLogMs = 0;

static uint8_t leakLevel(uint8_t b) { return b == 1 ? g_leakLevel : 0; }
static float   leakLoss(uint8_t b)  { return b == 1 ? g_leakLoss : 0.0f; }
static bool    leakIsLatched(uint8_t b) { return leakLevel(b) >= 2; }

// Close the leaking lane, then hand the water to the backup lane.
static void leakLatch(LeakKind kind, float loss) {
  g_leakLevel = (kind == LK_BURST) ? 3 : 2;
  LOG("LEAK", "B1 %s loss=%.1f%% confirmed -> closing V1", kind == LK_BURST ? "BURST" : "DRIP", loss);
  evtPost(EV_LEAK, 1, SRC_LEAK, kind, loss);
  g_holdInterlock = true;                       // both valves are closed for the next 300 ms
  relaysValveSet(1, false, 0, SRC_LEAK, nullptr);
#if FAILOVER_ON_LEAK
  delay(FAILOVER_BREAK_MS);                     // break before make, as on the bench rig
  if (!relaysValveOn(2)) {
    LOG("LEAK", "failover -> opening V2 (backup lane)");
    relaysValveSet(2, true, 0, SRC_LEAK, nullptr, RSN_FAILOVER);
  }
#endif
  g_holdInterlock = false;
  pumpInterlock();                              // honour it now that the swap is finished
}

// Called once per second, right after flowSample().
static void leakTick(uint32_t now) {
  bool settling = (now - relaysLastChangeMs(1)) < (uint32_t)LEAK_SETTLE_S * 1000UL;
  float in = g_winLpm[0], out = g_winLpm[1];
  if (!relaysValveOn(1) || settling || in < LEAK_MIN_FLOW_LPM) {
    g_leakLoss = 0; g_dripS = 0; g_burstS = 0;
    if (g_leakLevel == 1) g_leakLevel = 0;      // warn clears, a latch stays
    return;
  }

  float loss = (in - out) / in * 100.0f;
  int32_t dPulses = (int32_t)g_winSum[0] - (int32_t)g_winSum[1];
  if (dPulses < LEAK_MIN_DELTA_PULSES) loss = 0;   // too small to be real on YF-S401s
  g_leakLoss = loss < 0 ? 0 : loss;

  if (loss <= SENSOR_FAULT_PCT && now - g_faultLogMs > 30000) {
    g_faultLogMs = now;
    LOG("LEAK", "B1 sensor mismatch: OUT %.2f > IN %.2f L/min (check wiring)", out, in);
  }
  if (g_leakLevel >= 2) return;                 // already latched, the valve is closed anyway

  if (loss >= LEAK_BURST_PCT)     { g_burstS++; g_dripS++; }
  else if (loss >= LEAK_DRIP_PCT) { g_dripS++; g_burstS = 0; }
  else if (loss < LEAK_CLEAR_PCT) { g_dripS = 0; g_burstS = 0; }
  // between CLEAR and DRIP: hold the counters (hysteresis)

  if (g_burstS >= LEAK_BURST_CONFIRM_S)     leakLatch(LK_BURST, loss);
  else if (g_dripS >= LEAK_DRIP_CONFIRM_S)  leakLatch(LK_DRIP, loss);
  else g_leakLevel = loss >= LEAK_WARN_PCT ? 1 : 0;
}

// Clear the latch only. Valves stay as they are and the pump stays off until commanded.
static void leakReset(Src src) {
  g_leakLevel = 0; g_leakLoss = 0; g_dripS = 0; g_burstS = 0;
  LOG("LEAK", "reset src=%s", SRC_NAMES[src]);
  evtPost(EV_LEAK_CLEAR, 0, src);
}

// ============================================================================
// JSON - builds and parses the wire messages (docs/PROTOCOL.md). ArduinoJson 7.
// ============================================================================

static float round2(float x) { return roundf(x * 100.0f) / 100.0f; }
static float round1(float x) { return roundf(x * 10.0f) / 10.0f; }

static size_t jsonHello(char* buf, size_t n, const char* id, const char* ip, int rssi, const char* rst) {
  JsonDocument d;
  d["t"] = "hello"; d["proto"] = 1; d["id"] = id; d["fw"] = FW_VERSION; d["ip"] = ip;
  d["rssi"] = rssi; d["rst"] = rst;
  JsonArray mon = d["mon"].to<JsonArray>();
  mon.add(1);            // branch 1 has IN/OUT sensors
  mon.add(0);            // branch 2 is valve-only
  d["sim"] = false;
  return serializeJson(d, buf, n);
}

static size_t jsonTel(char* buf, size_t n, const Snapshot& s, int rssi, uint32_t upS, uint32_t heap) {
  JsonDocument d;
  d["t"] = "tel"; d["ms"] = s.ms; d["seq"] = s.seq;
  JsonArray f = d["f"].to<JsonArray>();
  for (uint8_t i = 0; i < NS; i++) f.add((float)round2(s.lpm[i]));
  JsonArray p = d["p"].to<JsonArray>();
  for (uint8_t i = 0; i < NS; i++) p.add(s.pulses[i]);
  JsonArray loss = d["loss"].to<JsonArray>();
  for (uint8_t b = 0; b < NB; b++) loss.add((float)round1(s.loss[b]));
  JsonArray leak = d["leak"].to<JsonArray>();
  for (uint8_t b = 0; b < NB; b++) leak.add(s.leak[b]);
  JsonArray v = d["v"].to<JsonArray>();
  for (uint8_t b = 0; b < NB; b++) v.add(s.valve[b]);
  d["pump"] = s.pump;
  d["turb"]["mv"] = s.turbMv; d["turb"]["ntu"] = s.ntu;
  d["tds"]["mv"] = s.tdsMv;   d["tds"]["ppm"] = s.ppm;
  d["rssi"] = rssi; d["up"] = upS; d["heap"] = heap; d["sim"] = false;
  return serializeJson(d, buf, n);
}

static size_t jsonEvt(char* buf, size_t n, const Evt& e) {
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

static size_t jsonAck(char* buf, size_t n, const AckMsg& a) {
  JsonDocument d;
  d["t"] = "ack"; d["id"] = a.id; d["ok"] = a.ok;
  if (a.err != ERR_NONE) d["err"] = ERR_NAMES[a.err];
  if (a.ok && a.ms) d["ms"] = a.ms;
  return serializeJson(d, buf, n);
}

// Parse {"t":"cmd","id":17,"act":"valve","b":1,"on":true,"dur":120}.
static Err jsonParseCmd(const char* txt, size_t len, Cmd& c) {
  JsonDocument d;
  c = Cmd{};
  if (deserializeJson(d, txt, len) != DeserializationError::Ok) return ERR_BAD_JSON;
  if (!d.is<JsonObject>()) return ERR_BAD_JSON;
  const char* t = d["t"] | (const char*)nullptr;
  if (!t || strcmp(t, "cmd") != 0) return ERR_BAD_JSON;
  c.id = d["id"] | 0UL;
  const char* act = d["act"] | (const char*)nullptr;
  if (!act) return ERR_BAD_JSON;
  if      (!strcmp(act, "valve"))      c.act = ACT_VALVE;
  else if (!strcmp(act, "pump"))       c.act = ACT_PUMP;
  else if (!strcmp(act, "all_off"))    c.act = ACT_ALL_OFF;
  else if (!strcmp(act, "reset_leak")) c.act = ACT_RESET_LEAK;
  else if (!strcmp(act, "ping"))       c.act = ACT_PING;
  else { c.act = ACT_UNKNOWN; return ERR_UNKNOWN_ACT; }
  c.b = (uint8_t)(d["b"] | 0);
  if (d["on"].is<bool>()) { c.hasOn = true; c.on = d["on"].as<bool>(); }
  int dur = d["dur"] | 0;
  c.dur = (uint16_t)(dur < 0 ? 0 : (dur > 65535 ? 65535 : dur));
  return ERR_NONE;
}

// ============================================================================
// NET - Wi-Fi (station, with an access-point fallback), mDNS and the WebSocket
// client, all inside one FreeRTOS task on core 0 so a slow connect can never
// stall the safety loop on core 1. Settings live in NVS, set over serial.
// ============================================================================

static NetCfg   g_cfg;
static char     g_devId[16] = "rig-000000";
static char     g_rstName[12] = "UNKNOWN";
static volatile bool g_wifiUp = false;
static bool     g_wifiWasUp = false;
static bool     g_wifiStarted = false;
static bool     g_apMode = false;
static uint32_t g_wifiDownSince = 0;
static uint32_t g_staStartMs = 0;
static uint32_t g_appliedCfgVersion = 0xFFFFFFFF;
static WebSocketsClient g_ws;
static bool     g_wsConfigured = false;
static volatile bool g_wsUp = false;
static uint32_t g_wsRetryMs = WS_RECONNECT_MIN_MS;
static uint32_t g_wsDownSince = 0;
static uint32_t g_wsLastNagMs = 0;
static uint32_t g_wsResolveRetryAt = 0;
static uint32_t g_lastTelMs = 0;
static bool     g_mdnsUp = false;
static char     g_wsHost[96];
static uint16_t g_wsPort = 80;
static char     g_wsPath[64] = "/ws";
static bool     g_wsSsl = false;
static char     g_netBuf[640];

static void netLoadCfg(NetCfg& c) {
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

// key = "ssid" | "pass" | "server" | "name". Applied live: the net task re-reads on its next pass.
static void netSaveCfg(const char* key, const char* value) {
  Preferences p;
  p.begin("rig", false);
  p.putString(key, value);
  p.end();
  g_cfgVersion = g_cfgVersion + 1;
  LOG("CFG", "saved %s, applying", key);
}

static void netShowCfg() {
  NetCfg c; netLoadCfg(c);
  LOG("CFG", "ssid='%s' pass=%s server=%s name=%s id=%s", c.ssid, c.pass[0] ? "***" : "(none)", c.server, c.name, g_devId);
}

static const char* netDeviceId() { return g_devId; }
static bool netWsUp()   { return g_wsUp; }
static bool netApMode() { return g_apMode; }

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

static void wsSend(const char* txt) { g_ws.sendTXT(txt); }

static void wsSendAck(const AckMsg& a) {
  if (!g_wsUp) return;
  jsonAck(g_netBuf, sizeof g_netBuf, a);
  wsSend(g_netBuf);
}

static void wsSendHello() {
  IPAddress ip = g_apMode ? WiFi.softAPIP() : WiFi.localIP();
  jsonHello(g_netBuf, sizeof g_netBuf, g_devId, ip.toString().c_str(), WiFi.RSSI(), g_rstName);
  wsSend(g_netBuf);
  LOG("WS", "tx hello id=%s", g_devId);
}

// Text from the server: only "cmd" is expected. Parse errors are acked here; real commands go to loop().
static void handleCmdText(const char* txt, size_t len) {
  Cmd c;
  Err e = jsonParseCmd(txt, len, c);
  c.src = SRC_WS;
  if (e != ERR_NONE) {
    AckMsg a = { c.id, false, e, millis(), SRC_WS };
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
      handleCmdText((const char*)payload, length);
      break;
    case WStype_ERROR:
      LOG("WS", "error");
      break;
    default:
      break;
  }
}

// Dial the server from the stored URL. A ".local" host is resolved over mDNS, which is how to
// survive a laptop whose DHCP address keeps moving.
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

// Last resort: make our own network so the rig is never unreachable at the fair.
// The laptop joins this AP and gets 192.168.4.2, which is where we then dial the server.
// One way only: reboot to try the configured Wi-Fi again.
static void netStartAp() {
  wsStop();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP);
  bool ok = strlen(AP_PASS) >= 8 ? WiFi.softAP(g_devId, AP_PASS) : WiFi.softAP(g_devId);
  g_apMode = true;
  strlcpy(g_cfg.server, AP_SERVER_URL, sizeof g_cfg.server);   // RAM only, NVS keeps your setting
  g_wsResolveRetryAt = 0;
  LOG("WIFI", "AP fallback %s: ssid='%s' pass='%s' ip=%s", ok ? "up" : "FAILED", g_devId,
      strlen(AP_PASS) >= 8 ? AP_PASS : "(open)", WiFi.softAPIP().toString().c_str());
  LOG("WIFI", "join it from the laptop, run the server, we dial %s", g_cfg.server);
}

// (Re)load settings and (re)start Wi-Fi + WebSocket. Runs in the net task.
static void netApplyCfg() {
  g_appliedCfgVersion = g_cfgVersion;
  netLoadCfg(g_cfg);
  wsStop();
  g_wsResolveRetryAt = 0;
  g_apMode = false;
  WiFi.mode(WIFI_STA);
  if (g_wifiStarted) WiFi.disconnect();
  g_wifiUp = false;
  g_wifiDownSince = millis();
  g_staStartMs = millis();
  WiFi.setHostname(g_cfg.name);
  if (!g_cfg.ssid[0]) {
    LOG("WIFI", "no ssid configured (type: ssid=YourNetwork), starting AP");
    netStartAp();
    return;
  }
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

    bool up = g_wifiUp || g_apMode;
    if (up && !g_wifiWasUp && !g_mdnsUp && MDNS.begin(g_cfg.name)) {
      g_mdnsUp = true;
      LOG("MDNS", "%s.local", g_cfg.name);
    }
    if (!up && g_wifiWasUp) { wsStop(); g_wifiDownSince = millis(); }
    g_wifiWasUp = up;

    if (!g_apMode && !g_wifiUp && g_wifiStarted) {
      // Never joined at all: give up on the network and bring up our own.
      if (millis() - g_staStartMs > (uint32_t)AP_FALLBACK_S * 1000UL) netStartAp();
      // Joined once and dropped: the driver auto-reconnects, kick it if it gives up.
      else if (millis() - g_wifiDownSince > (uint32_t)WIFI_BACKSTOP_S * 1000UL) {
        g_wifiDownSince = millis();
        LOG("WIFI", "still down, retrying '%s'", g_cfg.ssid);
        WiFi.disconnect();
        WiFi.begin(g_cfg.ssid, g_cfg.pass);
      }
    }

    if (up) {
      if (!g_wsConfigured) wsStart();
      if (g_wsConfigured) { wsBackoff(); g_ws.loop(); }
      if (g_wsUp && millis() - g_lastTelMs >= TEL_PERIOD_MS) {
        g_lastTelMs = millis();
        Snapshot s; snapshotCopy(s);
        jsonTel(g_netBuf, sizeof g_netBuf, s, WiFi.RSSI(), millis() / 1000, ESP.getFreeHeap());
        wsSend(g_netBuf);
      }
    }

    // Events and acks: sent when connected, otherwise dropped (the next tel carries full state).
    Evt e;
    while (xQueueReceive(g_evtQ, &e, 0) == pdTRUE) {
      if (g_wsUp) { jsonEvt(g_netBuf, sizeof g_netBuf, e); wsSend(g_netBuf); }
    }
    AckMsg a;
    while (xQueueReceive(g_ackQ, &a, 0) == pdTRUE) wsSendAck(a);

    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

static void netInit() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(g_devId, sizeof g_devId, "rig-%02x%02x%02x", mac[3], mac[4], mac[5]);
  strlcpy(g_rstName, resetName(esp_reset_reason()), sizeof g_rstName);
  netShowCfg();
  xTaskCreatePinnedToCore(netTask, "net", NET_TASK_STACK, nullptr, 1, nullptr, NET_TASK_CORE);
}

// ============================================================================
// CONSOLE - serial command line on both the USB port and the UART0 pins.
// "help" lists everything. "!" works instantly, without Enter.
// ============================================================================

static char    g_lineUsb[96], g_lineUart[96];
static uint8_t g_lenUsb = 0, g_lenUart = 0;
static bool    g_telPrint = false;
static bool    g_scanPending = false;
static char    g_conBuf[640];

static void consoleHelp() {
  LOG("MENU", "!                    all relays off now (no Enter needed)");
  LOG("MENU", "help show id wifi scan reboot stat adc tel on|off");
  LOG("MENU", "ssid=<name> pass=<pw> server=ws://host:port/ws name=<mdns>   (saved, applied live)");
  LOG("MENU", "v1 on [sec] | off    branch 1 valve (monitored lane)");
  LOG("MENU", "v2 on [sec] | off    branch 2 valve (backup lane)");
  LOG("MENU", "pump on [sec] | off  off (=all off)   reset (clear the leak latch)");
}

static void consoleRunCmd(Cmd c) {
  c.src = SRC_SERIAL;
  AckMsg a = applyCmd(c);
  if (!a.ok) LOG("CMD", "refused: %s", ERR_NAMES[a.err]);
}

static void consoleStat() {
  LOG("STAT", "flow in=%.2f out=%.2f L/min  pulses in=%lu out=%lu",
      g_lpm[0], g_lpm[1], (unsigned long)g_rawCount[0], (unsigned long)g_rawCount[1]);
  LOG("STAT", "window in=%.2f out=%.2f L/min  delta=%ld pulses (trip at %d)",
      g_winLpm[0], g_winLpm[1], (long)((int32_t)g_winSum[0] - (int32_t)g_winSum[1]), LEAK_MIN_DELTA_PULSES);
  LOG("STAT", "loss=%.1f%% leak=%u  v1=%u v2=%u pump=%u",
      g_leakLoss, g_leakLevel, relaysValveOn(1), relaysValveOn(2), relaysPumpOn());
}

static void consoleAdc() {
  int turbMv, ntu, tdsMv, ppm;
  sensorsRead(&turbMv, &ntu, &tdsMv, &ppm);
  LOG("ADC", "turb=%d mV ntu=%d  tds=%d mV ppm=%d", turbMv, ntu, tdsMv, ppm);
}

static void consoleWifi() {
  if (netApMode()) {
    LOG("WIFI", "AP mode ssid='%s' ip=%s clients=%d ws=%s", g_devId,
        WiFi.softAPIP().toString().c_str(), WiFi.softAPgetStationNum(), netWsUp() ? "connected" : "down");
    return;
  }
  LOG("WIFI", "status=%d ip=%s rssi=%d ws=%s id=%s", (int)WiFi.status(), WiFi.localIP().toString().c_str(),
      WiFi.RSSI(), netWsUp() ? "connected" : "down", netDeviceId());
}

static void consoleExec(char* line) {
  char* eq = strchr(line, '=');                       // settings: key=value
  if (eq && line[0] != ' ' && line[0] != '\t') {
    *eq = 0;
    const char* key = line; const char* val = eq + 1;
    if (!strcmp(key, "ssid") || !strcmp(key, "pass") || !strcmp(key, "server") || !strcmp(key, "name")) {
      netSaveCfg(key, val);
      return;
    }
    LOG("ERR", "unknown setting '%s'", key);
    return;
  }
  char* save = nullptr;
  char* w0 = strtok_r(line, " \t", &save);
  if (!w0) return;
  char* w1 = strtok_r(nullptr, " \t", &save);
  char* w2 = strtok_r(nullptr, " \t", &save);
  Cmd c = {};

  if (!strcmp(w0, "help") || !strcmp(w0, "h") || !strcmp(w0, "?")) { consoleHelp(); return; }
  if (!strcmp(w0, "show"))   { netShowCfg(); return; }
  if (!strcmp(w0, "id"))     { LOG("CFG", "id=%s fw=%s", netDeviceId(), FW_VERSION); return; }
  if (!strcmp(w0, "wifi"))   { consoleWifi(); return; }
  if (!strcmp(w0, "scan"))   { WiFi.scanNetworks(true); g_scanPending = true; LOG("WIFI", "scanning..."); return; }
  if (!strcmp(w0, "reboot")) { LOG("BOOT", "rebooting"); delay(100); ESP.restart(); return; }
  if (!strcmp(w0, "stat"))   { consoleStat(); return; }
  if (!strcmp(w0, "adc"))    { consoleAdc(); return; }
  if (!strcmp(w0, "tel"))    { g_telPrint = w1 && !strcmp(w1, "on"); LOG("MENU", "tel print %s", g_telPrint ? "on" : "off"); return; }
  if (!strcmp(w0, "off") || !strcmp(w0, "!")) { c.act = ACT_ALL_OFF; consoleRunCmd(c); return; }
  if (!strcmp(w0, "reset"))  { c.act = ACT_RESET_LEAK; consoleRunCmd(c); return; }
  if (w0[0] == 'v' && w0[1] >= '1' && w0[1] <= '0' + NB && w0[2] == 0) {
    if (!w1) { LOG("ERR", "usage: v%c on [sec] | off", w0[1]); return; }
    c.act = ACT_VALVE; c.b = w0[1] - '0'; c.hasOn = true; c.on = !strcmp(w1, "on"); c.dur = w2 ? (uint16_t)atoi(w2) : 0;
    consoleRunCmd(c); return;
  }
  if (!strcmp(w0, "pump")) {
    if (!w1) { LOG("ERR", "usage: pump on [sec] | off"); return; }
    c.act = ACT_PUMP; c.hasOn = true; c.on = !strcmp(w1, "on"); c.dur = w2 ? (uint16_t)atoi(w2) : 0;
    consoleRunCmd(c); return;
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

static void consoleTick() {
  consoleFeed(Serial, g_lineUsb, g_lenUsb);
  consoleFeed(Serial0, g_lineUart, g_lenUart);
  if (g_scanPending) {
    int16_t n = WiFi.scanComplete();
    if (n >= 0) {
      g_scanPending = false;
      LOG("WIFI", "scan: %d networks", (int)n);
      for (int16_t i = 0; i < n && i < 10; i++)
        LOG("WIFI", "  %-24s %4d dBm ch%2d", WiFi.SSID(i).c_str(), (int)WiFi.RSSI(i), (int)WiFi.channel(i));
      WiFi.scanDelete();
    } else if (n == WIFI_SCAN_FAILED) { g_scanPending = false; LOG("WIFI", "scan failed"); }
  }
}

// ============================================================================
// SETUP / LOOP
// ============================================================================

static uint32_t g_seq = 0;
static uint32_t g_nextSampleMs = 0;
static uint32_t g_nextRelayMs = 0;

void setup() {
  relaysSafeInit();            // FIRST: every relay off before anything else can run
  logBegin();
  delay(50);
  LOG("BOOT", "%s firmware %s built %s %s", BRAND_NAME, FW_VERSION, __DATE__, __TIME__);
  LOG("BOOT", "chip=%s cpu=%luMHz flash=%luMB psram=%luKB core=%s",
      ESP.getChipModel(), (unsigned long)ESP.getCpuFreqMHz(),
      (unsigned long)(ESP.getFlashChipSize() / (1024 * 1024)),
      (unsigned long)(ESP.getPsramSize() / 1024), ESP.getCoreVersion());
  LOG("BOOT", "branch 1 '%s' = monitored (GPIO%u in / GPIO%u out), branch 2 '%s' = valve only",
      BRAND_BRANCH_1, (unsigned)F_IN, (unsigned)F_OUT, BRAND_BRANCH_2);
  g_cmdQ = xQueueCreate(8, sizeof(Cmd));
  g_ackQ = xQueueCreate(8, sizeof(AckMsg));
  g_evtQ = xQueueCreate(16, sizeof(Evt));
  LOG("RELAY", "safe init: V1 V2 PUMP all OFF");
  flowInit();
  sensorsInit();
  LOG("LEAK", "min=%.1fL/min delta>=%d pulses warn=%.0f%% drip=%.0f%%/%us burst=%.0f%%/%us failover=%s",
      LEAK_MIN_FLOW_LPM, LEAK_MIN_DELTA_PULSES, LEAK_WARN_PCT, LEAK_DRIP_PCT, (unsigned)LEAK_DRIP_CONFIRM_S,
      LEAK_BURST_PCT, (unsigned)LEAK_BURST_CONFIRM_S, FAILOVER_ON_LEAK ? "on" : "off");
  netInit();                   // starts the core-0 network task
  LOG("MENU", "type 'help' for commands; '!' = all relays off");
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
    if (c.src == SRC_WS) ackPost(a);
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
    for (uint8_t i = 0; i < NS; i++) { s.lpm[i] = g_lpm[i]; s.pulses[i] = g_rawCount[i]; }
    for (uint8_t b = 0; b < NB; b++) {
      s.loss[b] = leakLoss(b + 1);
      s.leak[b] = leakLevel(b + 1);
      s.valve[b] = relaysValveOn(b + 1) ? 1 : 0;
    }
    s.pump = relaysPumpOn() ? 1 : 0;
    snapshotPublish(s);
    if (g_telPrint) {
      jsonTel(g_conBuf, sizeof g_conBuf, s, WiFi.RSSI(), millis() / 1000, ESP.getFreeHeap());
      Serial.println(g_conBuf);
      Serial0.println(g_conBuf);
    }
  }

  delay(1);                                          // yield; nothing above blocks for long
}

// Apply one command from serial or the WebSocket. Returns the ack to send back.
AckMsg applyCmd(const Cmd& c) {
  AckMsg a = { c.id, true, ERR_NONE, millis(), c.src };
  Err err = ERR_NONE;
  switch (c.act) {
    case ACT_VALVE:
      if (c.b < 1 || c.b > NB) { err = ERR_BAD_BRANCH; break; }
      if (c.hasOn && c.on && leakIsLatched(c.b)) { err = ERR_LATCHED; break; }
      LOG("CMD", "valve b=%u %s dur=%u src=%s", c.b, (c.hasOn ? c.on : true) ? "on" : "off",
          (unsigned)c.dur, SRC_NAMES[c.src]);
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
    default:
      err = ERR_UNKNOWN_ACT;
      break;
  }
  if (err != ERR_NONE) { a.ok = false; a.err = err; }
  return a;
}
