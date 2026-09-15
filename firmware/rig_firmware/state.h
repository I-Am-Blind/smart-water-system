// state.h - the few things shared between the two tasks.
//   loop() (core 1) owns sensors, leak logic and relays. It publishes a Snapshot once per second.
//   netTask (core 0) owns Wi-Fi, WebSocket and HTTP. It only reads snapshots and posts commands.
// Commands flow net -> loop through g_cmdQ; acks and events flow loop -> net through g_ackQ / g_evtQ.
#pragma once
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

// ---- enums used on the wire (names must match docs/PROTOCOL.md) ----
enum Act : uint8_t { ACT_VALVE, ACT_PUMP, ACT_ALL_OFF, ACT_RESET_LEAK, ACT_PING, ACT_SIM, ACT_UNKNOWN };
enum Src : uint8_t { SRC_SERIAL, SRC_WS, SRC_HTTP, SRC_LEAK, SRC_WD, SRC_INTERLOCK, SRC_BOOT };
enum EvKind : uint8_t { EV_BOOT, EV_LEAK, EV_LEAK_CLEAR, EV_MLEAK, EV_VALVE, EV_PUMP, EV_ALL_OFF, EV_SIM };
enum Reason : uint8_t { RSN_NONE, RSN_MAX_ON, RSN_ALL_CLOSED, RSN_MANIFOLD };
enum Err : uint8_t { ERR_NONE, ERR_LATCHED, ERR_BAD_BRANCH, ERR_NO_OPEN_VALVE, ERR_UNKNOWN_ACT, ERR_BAD_JSON };
enum LeakKind : uint8_t { LK_NONE, LK_DRIP, LK_BURST };

static const char* const SRC_NAMES[]    = { "serial", "ws", "http", "leak", "wd", "interlock", "boot" };
static const char* const EV_NAMES[]     = { "boot", "leak", "leak_clear", "mleak", "valve", "pump", "all_off", "sim" };
static const char* const REASON_NAMES[] = { "", "max_on", "all_closed", "manifold" };
static const char* const ERR_NAMES[]    = { "", "latched", "bad_branch", "no_open_valve", "unknown_act", "bad_json" };
static const char* const KIND_NAMES[]   = { "", "drip", "burst" };

// A command, from serial / WebSocket / HTTP, waiting to be applied by loop().
struct Cmd {
  uint32_t id;      // echoed in the ack (0 for serial)
  Act      act;
  uint8_t  b;       // branch 1..3 (0 = none)
  bool     hasOn;
  bool     on;
  uint16_t dur;     // seconds, 0 = default
  int16_t  pct;     // sim loss percent, -1 = none
  Src      src;
};

// Result of a command, sent back to whoever asked.
struct AckMsg {
  uint32_t id;
  bool     ok;
  Err      err;
  uint32_t ms;      // millis() at execution (reported for ping)
  Src      src;     // where the command came from, so the net task knows where to reply
};

// Something happened (leak, relay change...). Turned into an "evt" JSON by the net task.
struct Evt {
  uint32_t ms;
  EvKind   ev;
  uint8_t  b;       // 0 = none
  LeakKind kind;
  float    loss;    // percent, <0 = none
  int8_t   on;      // -1 = none, 0/1 = new state
  Src      src;
  Reason   reason;
};

// Everything the outside world needs to know, published once per second by loop().
struct Snapshot {
  uint32_t ms, seq;
  float    lpm[7];
  uint32_t pulses[7];
  float    loss[3];
  uint8_t  leak[3];   // 0 ok, 1 warn, 2 drip, 3 burst
  uint8_t  mleak;
  uint8_t  valve[3];
  uint8_t  pump;
  int      turbMv, ntu, tdsMv, ppm;
  bool     sim;
};

static portMUX_TYPE   g_mux = portMUX_INITIALIZER_UNLOCKED;
static Snapshot       g_snap = {};
static QueueHandle_t  g_cmdQ = nullptr;   // net -> loop
static QueueHandle_t  g_ackQ = nullptr;   // loop -> net
static QueueHandle_t  g_evtQ = nullptr;   // loop -> net
static volatile uint32_t g_cfgVersion = 0; // bumped by the console when settings change

void stateInit() {
  g_cmdQ = xQueueCreate(8, sizeof(Cmd));
  g_ackQ = xQueueCreate(8, sizeof(AckMsg));
  g_evtQ = xQueueCreate(16, sizeof(Evt));
}

void snapshotPublish(const Snapshot& s) {
  taskENTER_CRITICAL(&g_mux);
  g_snap = s;
  taskEXIT_CRITICAL(&g_mux);
}

void snapshotCopy(Snapshot& out) {
  taskENTER_CRITICAL(&g_mux);
  out = g_snap;
  taskEXIT_CRITICAL(&g_mux);
}

// Post an event; never blocks. If the queue is full the event is dropped (the next tel carries full state).
void evtPost(EvKind ev, uint8_t b, Src src, LeakKind kind = LK_NONE, float loss = -1.0f, int8_t on = -1, Reason reason = RSN_NONE) {
  Evt e = {};
  e.ms = millis(); e.ev = ev; e.b = b; e.kind = kind; e.loss = loss; e.on = on; e.src = src; e.reason = reason;
  if (g_evtQ) xQueueSend(g_evtQ, &e, 0);
}

bool cmdPost(const Cmd& c) { return g_cmdQ && xQueueSend(g_cmdQ, &c, 0) == pdTRUE; }
bool ackPost(const AckMsg& a) { return g_ackQ && xQueueSend(g_ackQ, &a, 0) == pdTRUE; }

// Defined in rig_firmware.ino: applies a command using the relay / leak / sim modules.
AckMsg applyCmd(const Cmd& c);
