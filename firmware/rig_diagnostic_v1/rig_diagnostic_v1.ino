/*
 * rig_diagnostic_v1  -  hardware bring-up sketch for the water-leak-detection rig
 * ---------------------------------------------------------------------------
 * Target : ESP32-S3-WROOM-1 N16R8 devkit (16 MB QIO flash, 8 MB OPI PSRAM)
 * Core   : Arduino-ESP32 3.x  (board "ESP32S3 Dev Module")
 * Libs   : none beyond the ESP32 core
 *
 * What it does
 *   Phase A (automatic, safe, no relay is ever energised):
 *     1. boot banner + required IDE settings   2. flow-pin idle/transition check
 *     3. 10 s pulse listen on 7 flow pins       4. ADC check on turbidity + TDS
 *     5. Wi-Fi scan (no connection)             6. 1 MB PSRAM allocation test
 *     7. one summary block for pasting back
 *   Phase B (single-key menu, from either serial port): see printMenu().
 *
 * Every log line is "[millis][TAG] message", ASCII only, max 100 chars, and is
 * mirrored to Serial (native USB CDC) and Serial0 (UART0 bridge).
 *
 * SAFETY: the very first thing setup() does is drive all four relay inputs HIGH
 * (the relay board is ACTIVE-LOW, so HIGH = relay off = valve closed / pump off).
 * Relays only ever switch on from explicit menu keys, and any relay that is on
 * is forced off again after 20 s. '!' switches everything off immediately.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <driver/gpio.h>
#include <esp_system.h>
#include <esp_mac.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#define SKETCH_NAME    "rig_diagnostic_v1"
#define SKETCH_VERSION "1.0.0"

// ============================ PIN MAP (exact) ================================
#define F0_MASTER   4    // flow sensor, master line (after the pump)
#define F1_IN       5    // flow sensor, branch 1 inlet
#define F1_OUT      6    // flow sensor, branch 1 outlet
#define F2_IN       7    // flow sensor, branch 2 inlet
#define F2_OUT      15   // flow sensor, branch 2 outlet
#define F3_IN       16   // flow sensor, branch 3 inlet
#define F3_OUT      17   // flow sensor, branch 3 outlet
#define TURBIDITY   8    // ADC1, via 10k/20k divider (about 3.0 V full scale at the pin)
#define TDS         9    // ADC1, direct (Seeed Grove TDS, max about 2.3 V)
#define RELAY_V1    11   // relay input, ACTIVE-LOW, solenoid branch 1
#define RELAY_V2    12   // relay input, ACTIVE-LOW, solenoid branch 2
#define RELAY_V3    13   // relay input, ACTIVE-LOW, solenoid branch 3
#define RELAY_PUMP  14   // relay input, ACTIVE-LOW, pump
// Reserved and never touched by this sketch:
//   0,3,45,46 (strapping)  19,20 (USB)  26-32 (flash)  35,36,37 (octal PSRAM)  43,44 (UART0 = Serial0)

// ============================ tunables =======================================
#define SERIAL_BAUD         115200
#define RELAY_AUTO_OFF_MS   20000UL   // any relay switched on by a key is forced off after this
#define PUMP_CONFIRM_MS     5000UL    // 'P' must be confirmed with 'y' within this time
#define PULSE_LISTEN_S      10        // idle pulse listen duration
#define FLOW_WATCH_S        15        // live flow watch duration
#define ADC_STREAM_S        10        // ADC stream duration (2 Hz)
#define NOISY_PULSES        10        // more than this during the idle listen = NOISY
#define ADC_NEAR_ZERO_MV    50        // below this = not connected / no power
#define ADC_NEAR_FS_MV      2900      // above this = near full scale of the 11 dB range
#define YF_S401_HZ_PER_LPM  98.0f     // YF-S401 datasheet: frequency (Hz) = 98 x flow (L/min)
#define MAX_LINE            100       // hard cap on log line length

// The board must be built with "USB CDC On Boot: Enabled". Then Serial is the native
// USB port and Serial0 is the UART0 bridge, and we can mirror to both.
#if ARDUINO_USB_CDC_ON_BOOT
#define TWO_PORTS 1
#else
#define TWO_PORTS 0   // Serial IS Serial0 in this configuration; print once only
#endif

// ============================ tables =========================================
static const uint8_t FLOW_PIN[7]   = { F0_MASTER, F1_IN, F1_OUT, F2_IN, F2_OUT, F3_IN, F3_OUT };
static const char*   FLOW_NAME[7]  = { "F0_MASTER", "F1_IN", "F1_OUT", "F2_IN", "F2_OUT", "F3_IN", "F3_OUT" };
static const char*   FLOW_SHORT[7] = { "M", "1i", "1o", "2i", "2o", "3i", "3o" };

struct Relay {
  uint8_t       pin;
  const char*   name;
  bool          on;
  unsigned long onSince;   // millis() when it was switched on (for the 20 s watchdog)
};
static Relay g_relay[4] = {
  { RELAY_V1,   "V1",   false, 0 },
  { RELAY_V2,   "V2",   false, 0 },
  { RELAY_V3,   "V3",   false, 0 },
  { RELAY_PUMP, "PUMP", false, 0 },
};
#define RELAY_PUMP_IDX 3

// Per-subsystem results shown in the summary block.
enum Status : uint8_t { ST_PASS = 0, ST_WARN = 1, ST_FAIL = 2 };
struct Result {
  const char* name;
  Status      st;
  char        reason[72];
};
enum ResultIdx { R_BOOT, R_PSRAM, R_FLOW_PINS, R_PULSE, R_ADC_TURB, R_ADC_TDS, R_WIFI, R_RELAYS, R_COUNT };
static Result g_res[R_COUNT] = {
  { "BOOT",      ST_WARN, "not run" },
  { "PSRAM",     ST_WARN, "not run" },
  { "FLOW_PINS", ST_WARN, "not run" },
  { "PULSE",     ST_WARN, "not run" },
  { "ADC_TURB",  ST_WARN, "not run" },
  { "ADC_TDS",   ST_WARN, "not run" },
  { "WIFI",      ST_WARN, "not run" },
  { "RELAYS",    ST_WARN, "not run" },
};

// Pulse counters, one per flow pin, incremented from the interrupt handlers.
static volatile uint32_t g_pulse[7];
// Idle levels seen by the pin-sanity test (1 = HIGH), used as notes by the pulse test.
static uint8_t  g_idleHigh[7];
static uint16_t g_transitions[7];

static const unsigned long BAUDS[4] = { 9600, 57600, 115200, 230400 };
static uint8_t g_baudIdx = 2;   // index into BAUDS for Serial0 (starts at 115200)

// ============================ logging ========================================
// logLine("TAG", "printf format", ...) -> "[millis][TAG] message" on both ports.
// Non-ASCII bytes become '?', and the line is cut at MAX_LINE characters.
static void logLine(const char* tag, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
static void logLine(const char* tag, const char* fmt, ...) {
  char msg[160];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);

  char line[MAX_LINE + 1];
  int n = snprintf(line, sizeof line, "[%lu][%s] %s", millis(), tag, msg);
  if (n > MAX_LINE) line[MAX_LINE - 1] = '~';   // mark a cut line so the reader knows
  for (char* p = line; *p; ++p) {
    if (*p < 0x20 || *p > 0x7e) *p = '?';
  }
  Serial.println(line);
#if TWO_PORTS
  Serial0.println(line);
#endif
}

static void setResult(ResultIdx i, Status st, const char* fmt, ...) __attribute__((format(printf, 3, 4)));
static void setResult(ResultIdx i, Status st, const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(g_res[i].reason, sizeof g_res[i].reason, fmt, ap);
  va_end(ap);
  g_res[i].st = st;
}

static const char* stName(Status s) {
  return s == ST_PASS ? "PASS" : (s == ST_WARN ? "WARN" : "FAIL");
}

// ============================ serial input ===================================
// Returns the next command character from either port, or -1. Whitespace is ignored
// so it does not matter whether the serial monitor sends a newline after the key.
static int readKey() {
  int c = -1;
  if (Serial.available() > 0) c = Serial.read();
#if TWO_PORTS
  else if (Serial0.available() > 0) c = Serial0.read();
#endif
  if (c == '\r' || c == '\n' || c == ' ' || c == '\t') return -1;
  return c;
}

// ============================ relays =========================================
static void relayWrite(uint8_t i, bool on) {
  digitalWrite(g_relay[i].pin, on ? LOW : HIGH);   // ACTIVE-LOW board
  g_relay[i].on = on;
  g_relay[i].onSince = millis();
}

static void relayOn(uint8_t i) {
  relayWrite(i, true);
  logLine("RELAY", "%s ON  (GPIO%u driven LOW) - auto-off in %lu s", g_relay[i].name, g_relay[i].pin,
          RELAY_AUTO_OFF_MS / 1000UL);
}

static void relayOff(uint8_t i, const char* tag, const char* why) {
  relayWrite(i, false);
  logLine(tag, "%s OFF (GPIO%u driven HIGH) - %s", g_relay[i].name, g_relay[i].pin, why);
}

// Emergency / all-off: used by '!' and never energises anything.
static void allRelaysOff(const char* why) {
  uint8_t wereOn = 0;
  for (uint8_t i = 0; i < 4; i++) {
    if (g_relay[i].on) { wereOn++; relayOff(i, "SAFE", why); }
  }
  logLine("SAFE", "ALL RELAYS OFF (%u were on) - %s", wereOn, why);
}

// The 20 s watchdog. Called from loop() and from every wait so it always runs.
static void relayWatchdog() {
  for (uint8_t i = 0; i < 4; i++) {
    if (g_relay[i].on && (millis() - g_relay[i].onSince) >= RELAY_AUTO_OFF_MS) {
      relayOff(i, "SAFE", "auto-off: 20 s watchdog expired");
    }
  }
}

// ============================ waiting helpers ================================
// Wait while keeping the relay watchdog alive and honouring the '!' emergency key.
static void waitUntil(unsigned long deadline) {
  while ((long)(millis() - deadline) < 0) {
    relayWatchdog();
    int k = readKey();
    if (k == '!') allRelaysOff("emergency stop key '!'");
    delay(2);
  }
}

static void waitMs(unsigned long ms) { waitUntil(millis() + ms); }

// Wait for a key for up to ms; returns the key or -1 on timeout. '!' is handled here too.
static int waitKey(unsigned long ms) {
  unsigned long deadline = millis() + ms;
  while ((long)(millis() - deadline) < 0) {
    relayWatchdog();
    int k = readKey();
    if (k == '!') { allRelaysOff("emergency stop key '!'"); return '!'; }
    if (k >= 0) return k;
    delay(2);
  }
  return -1;
}

// ============================ pulse counting =================================
// One tiny interrupt handler for all seven pins; the pin index arrives as the argument.
// It must live in IRAM (IRAM_ATTR) so it works even while flash is busy.
static void IRAM_ATTR flowIsr(void* arg) {
  uint32_t i = (uint32_t)(uintptr_t)arg;
  uint32_t v = g_pulse[i];
  g_pulse[i] = v + 1;
}

static void pulsesReset() {
  for (uint8_t i = 0; i < 7; i++) g_pulse[i] = 0;
}

static void pulsesAttach() {
  for (uint8_t i = 0; i < 7; i++) {
    pinMode(FLOW_PIN[i], INPUT);
    attachInterruptArg(FLOW_PIN[i], flowIsr, (void*)(uintptr_t)i, FALLING);
  }
}

static void pulsesDetach() {
  for (uint8_t i = 0; i < 7; i++) detachInterrupt(FLOW_PIN[i]);
}

static void pulsesSnapshot(uint32_t out[7]) {
  for (uint8_t i = 0; i < 7; i++) out[i] = g_pulse[i];
}

// ============================ helpers for the banner =========================
static const char* resetReasonName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:   return "POWERON";
    case ESP_RST_EXT:       return "EXT_PIN";
    case ESP_RST_SW:        return "SOFTWARE";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INT_WDT";
    case ESP_RST_TASK_WDT:  return "TASK_WDT";
    case ESP_RST_WDT:       return "OTHER_WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    case ESP_RST_SDIO:      return "SDIO";
    default:                return "UNKNOWN";
  }
}

static const char* flashModeName(FlashMode_t m) {
  switch (m) {
    case FM_QIO:       return "QIO";
    case FM_QOUT:      return "QOUT";
    case FM_DIO:       return "DIO";
    case FM_DOUT:      return "DOUT";
    case FM_FAST_READ: return "FAST_READ";
    case FM_SLOW_READ: return "SLOW_READ";
    default:           return "UNKNOWN";
  }
}

static const char* authName(wifi_auth_mode_t m) {
  switch (m) {
    case WIFI_AUTH_OPEN:            return "OPEN";
    case WIFI_AUTH_WEP:             return "WEP";
    case WIFI_AUTH_WPA_PSK:         return "WPA";
    case WIFI_AUTH_WPA2_PSK:        return "WPA2";
    case WIFI_AUTH_WPA_WPA2_PSK:    return "WPA/WPA2";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-ENT";
    case WIFI_AUTH_WPA3_PSK:        return "WPA3";
    case WIFI_AUTH_WPA2_WPA3_PSK:   return "WPA2/WPA3";
    default:                        return "OTHER";
  }
}

// ============================ PHASE A, step 1: banner ========================
static void phaseBanner() {
  logLine("BOOT", "===== %s v%s =====", SKETCH_NAME, SKETCH_VERSION);
  logLine("BOOT", "compiled %s %s", __DATE__, __TIME__);
  logLine("BOOT", "REQUIRED IDE SETTINGS (Tools menu) - compare with the detected values below:");
  logLine("BOOT", "  Board: ESP32S3 Dev Module | USB CDC On Boot: Enabled");
  logLine("BOOT", "  USB Mode: Hardware CDC and JTAG | Flash Mode: QIO 80MHz");
  logLine("BOOT", "  Flash Size: 16MB (128Mb) | PSRAM: OPI PSRAM");

  // Values baked in at compile time by the IDE settings.
#ifdef ARDUINO_USB_MODE
  const char* usbMode = ARDUINO_USB_MODE ? "HW-CDC/JTAG" : "USB-OTG";
#else
  const char* usbMode = "unknown";
#endif
#ifdef BOARD_HAS_PSRAM
  const char* psramFlag = "yes";
#else
  const char* psramFlag = "NO";
#endif
#if defined(CONFIG_SPIRAM_MODE_OCT)
  const char* psramMode = "OPI";
#elif defined(CONFIG_SPIRAM_MODE_QUAD)
  const char* psramMode = "QSPI";
#else
  const char* psramMode = "none";
#endif
  logLine("BOOT", "detected build: CDC_ON_BOOT=%d USB_MODE=%s PSRAM_FLAG=%s PSRAM_MODE=%s",
          (int)ARDUINO_USB_CDC_ON_BOOT, usbMode, psramFlag, psramMode);

  // Values read from the chip at run time.
  const uint32_t flashSize = ESP.getFlashChipSize();
  const uint32_t psramSize = ESP.getPsramSize();
  logLine("BOOT", "chip: %s rev %u, %u cores, CPU %lu MHz", ESP.getChipModel(), (unsigned)ESP.getChipRevision(),
          (unsigned)ESP.getChipCores(), (unsigned long)ESP.getCpuFreqMHz());
  logLine("BOOT", "flash: %lu B (%lu MB) mode=%s speed=%lu MHz", (unsigned long)flashSize,
          (unsigned long)(flashSize / 1048576UL), flashModeName(ESP.getFlashChipMode()),
          (unsigned long)(ESP.getFlashChipSpeed() / 1000000UL));
  logLine("BOOT", "psram: found=%s size=%lu B (%lu MB) free=%lu B", psramFound() ? "yes" : "NO",
          (unsigned long)psramSize, (unsigned long)(psramSize / 1048576UL), (unsigned long)ESP.getFreePsram());
  logLine("BOOT", "heap: free=%lu B  core=%s  idf=%s", (unsigned long)ESP.getFreeHeap(), ESP.getCoreVersion(),
          ESP.getSdkVersion());
  const esp_reset_reason_t rr = esp_reset_reason();
  logLine("BOOT", "reset reason: %s (%d)", resetReasonName(rr), (int)rr);
  uint8_t mac[6] = { 0, 0, 0, 0, 0, 0 };
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  logLine("BOOT", "mac: %02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

  // Judge the IDE settings that matter: CDC on boot, 16 MB flash, 8 MB PSRAM.
  char bad[48] = "";
  if (!ARDUINO_USB_CDC_ON_BOOT) strlcat(bad, " cdc-off", sizeof bad);
  if (flashSize < 16UL * 1048576UL) strlcat(bad, " flash<16MB", sizeof bad);
  if (psramSize < 8UL * 1048576UL) strlcat(bad, " psram<8MB", sizeof bad);
  if (bad[0] == 0) {
    setResult(R_BOOT, ST_PASS, "cdc=1 flash=%luMB psram=%luMB core=%s reset=%s",
              (unsigned long)(flashSize / 1048576UL), (unsigned long)(psramSize / 1048576UL),
              ESP.getCoreVersion(), resetReasonName(rr));
  } else {
    setResult(R_BOOT, ST_WARN, "IDE settings differ:%s (reset=%s)", bad, resetReasonName(rr));
  }
}

// ============================ PHASE A, step 2: pin sanity ====================
// Reads each flow pin 100 times over 1 s. A healthy idle line sits steady (HIGH or LOW
// depending on where the sensor rotor stopped). A line that keeps changing with the
// water off is floating or picking up noise.
static void phasePinSanity() {
  logLine("PIN", "configuring 7 flow pins as INPUT (no pull-up; the 10k/20k dividers drive them)");
  int last[7];
  uint16_t high[7];
  for (uint8_t i = 0; i < 7; i++) {
    pinMode(FLOW_PIN[i], INPUT);
    logLine("PIN", "%s GPIO%u -> INPUT", FLOW_NAME[i], FLOW_PIN[i]);
    last[i] = digitalRead(FLOW_PIN[i]);
    high[i] = 0;
    g_transitions[i] = 0;
  }
  for (int s = 0; s < 100; s++) {           // 100 reads x 10 ms = 1 s
    for (uint8_t i = 0; i < 7; i++) {
      int v = digitalRead(FLOW_PIN[i]);
      if (v) high[i]++;
      if (v != last[i]) { g_transitions[i]++; last[i] = v; }
    }
    delay(10);
  }
  uint8_t floating = 0, lowLines = 0;
  for (uint8_t i = 0; i < 7; i++) {
    g_idleHigh[i] = (high[i] >= 50) ? 1 : 0;
    if (!g_idleHigh[i]) lowLines++;
    const char* note = "";
    if (g_transitions[i] > 5) { note = " <- FLOATING/NOISY?"; floating++; }
    else if (!g_idleHigh[i]) note = " (LOW: rotor position or no 5V?)";
    logLine("PIN", "%s GPIO%u idle=%s high=%u/100 trans=%u%s", FLOW_NAME[i], FLOW_PIN[i],
            g_idleHigh[i] ? "HIGH" : "LOW", high[i], g_transitions[i], note);
  }
  if (floating) {
    setResult(R_FLOW_PINS, ST_WARN, "%u pin(s) toggling with water off (floating/noisy)", floating);
  } else if (lowLines == 7) {
    setResult(R_FLOW_PINS, ST_WARN, "all 7 lines LOW at rest: check 5V supply to the sensors");
  } else if (lowLines) {
    setResult(R_FLOW_PINS, ST_PASS, "7 pins steady, %u LOW at rest (rotor position?)", lowLines);
  } else {
    setResult(R_FLOW_PINS, ST_PASS, "7 pins steady HIGH, 0 transitions in 1 s");
  }
}

// ============================ PHASE A, step 3: pulse listen ==================
// Counts FALLING edges on every flow pin for 10 s. With the water off a healthy line
// gives 0-2 pulses; more than 10 means electrical noise or a floating input.
static void phasePulseListen() {
  logLine("PULSE", "listening %u s for pulses on all 7 flow pins (FALLING edges), water OFF please",
          (unsigned)PULSE_LISTEN_S);
  pulsesReset();
  pulsesAttach();
  waitMs(PULSE_LISTEN_S * 1000UL);
  pulsesDetach();
  uint32_t cnt[7];
  pulsesSnapshot(cnt);
  uint32_t maxCnt = 0;
  uint8_t noisy = 0;
  for (uint8_t i = 0; i < 7; i++) {
    const char* verdict = "OK";
    if (cnt[i] > NOISY_PULSES) { verdict = "NOISY"; noisy++; }
    else if (cnt[i] > 2) verdict = "a few (check)";
    const char* note = "";
    if (cnt[i] == 0 && !g_idleHigh[i]) note = " note: stuck LOW";
    else if (cnt[i] == 0 && g_transitions[i] == 0) note = " note: steady HIGH";
    logLine("PULSE", "%s GPIO%u count=%lu in %u s -> %s%s", FLOW_NAME[i], FLOW_PIN[i], (unsigned long)cnt[i],
            (unsigned)PULSE_LISTEN_S, verdict, note);
    if (cnt[i] > maxCnt) maxCnt = cnt[i];
  }
  if (noisy) setResult(R_PULSE, ST_WARN, "%u NOISY pin(s), max %lu pulses in 10 s", noisy, (unsigned long)maxCnt);
  else if (maxCnt > 2) setResult(R_PULSE, ST_WARN, "max %lu pulses in 10 s with water off", (unsigned long)maxCnt);
  else setResult(R_PULSE, ST_PASS, "max %lu pulses in 10 s (0-2 expected)", (unsigned long)maxCnt);
}

// ============================ PHASE A, step 4: ADC ===========================
static void adcSetup() {
  analogReadResolution(12);                       // 0..4095
  analogSetPinAttenuation(TURBIDITY, ADC_11db);   // widest range, about 0..3.1 V
  analogSetPinAttenuation(TDS, ADC_11db);
}

// Average of n calibrated millivolt readings and n raw 12-bit readings.
static void adcAverage(uint8_t pin, uint32_t n, uint32_t* mv, uint32_t* raw) {
  uint32_t sumMv = 0, sumRaw = 0;
  for (uint32_t k = 0; k < n; k++) {
    sumMv += analogReadMilliVolts(pin);
    sumRaw += (uint32_t)analogRead(pin);
  }
  *mv = sumMv / n;
  *raw = sumRaw / n;
}

static void adcJudge(ResultIdx r, const char* name, uint32_t mv) {
  if (mv < ADC_NEAR_ZERO_MV)   setResult(r, ST_WARN, "%lu mV near zero: not connected or no power?", (unsigned long)mv);
  else if (mv > ADC_NEAR_FS_MV) setResult(r, ST_WARN, "%lu mV near full scale (check divider/%s)", (unsigned long)mv, name);
  else                          setResult(r, ST_PASS, "%lu mV", (unsigned long)mv);
}

static void phaseAdc() {
  logLine("ADC", "12-bit, 11 dB attenuation, 64-sample averages via analogReadMilliVolts()");
  adcSetup();
  uint32_t mv, raw;
  adcAverage(TURBIDITY, 64, &mv, &raw);
  logLine("ADC", "TURBIDITY GPIO%u avg=%lu mV raw=%lu/4095 (64 samples)", (unsigned)TURBIDITY, (unsigned long)mv,
          (unsigned long)raw);
  adcJudge(R_ADC_TURB, "turbidity", mv);
  adcAverage(TDS, 64, &mv, &raw);
  logLine("ADC", "TDS       GPIO%u avg=%lu mV raw=%lu/4095 (64 samples)", (unsigned)TDS, (unsigned long)mv,
          (unsigned long)raw);
  adcJudge(R_ADC_TDS, "tds", mv);
}

// ============================ PHASE A, step 5: Wi-Fi scan ====================
static void phaseWifi() {
  logLine("WIFI", "scanning (STA mode, scan only, no connection is made)...");
  WiFi.mode(WIFI_STA);
  delay(100);
  int16_t n = WiFi.scanNetworks();
  if (n < 0) {
    logLine("WIFI", "scan failed (code %d)", (int)n);
    setResult(R_WIFI, ST_FAIL, "scan failed (code %d)", (int)n);
  } else if (n == 0) {
    logLine("WIFI", "scan ok but 0 networks found");
    setResult(R_WIFI, ST_WARN, "radio ok, 0 networks in range");
  } else {
    logLine("WIFI", "%d networks found, strongest 5:", (int)n);
    // Pick the 5 strongest by RSSI (simple selection, n is small).
    bool used[64] = { false };
    int16_t limit = n > 64 ? 64 : n;
    int32_t best = -1000;
    for (int rank = 1; rank <= 5 && rank <= limit; rank++) {
      int16_t bi = -1;
      for (int16_t i = 0; i < limit; i++) {
        if (!used[i] && (bi < 0 || WiFi.RSSI(i) > WiFi.RSSI(bi))) bi = i;
      }
      if (bi < 0) break;
      used[bi] = true;
      if (WiFi.RSSI(bi) > best) best = WiFi.RSSI(bi);
      String ssid = WiFi.SSID(bi);
      logLine("WIFI", "#%d rssi=%ld dBm ch=%ld %s ssid=\"%.32s\"", rank, (long)WiFi.RSSI(bi), (long)WiFi.channel(bi),
              authName(WiFi.encryptionType(bi)), ssid.c_str());
    }
    setResult(R_WIFI, ST_PASS, "%d networks, strongest %ld dBm", (int)n, (long)best);
  }
  WiFi.scanDelete();
  WiFi.mode(WIFI_OFF);
}

// ============================ PHASE A, step 6: PSRAM =========================
static void phasePsram() {
  const bool found = psramFound();
  const uint32_t size = ESP.getPsramSize();
  logLine("PSRAM", "psramFound=%s size=%lu B free=%lu B", found ? "yes" : "NO", (unsigned long)size,
          (unsigned long)ESP.getFreePsram());
  if (!found || size == 0) {
    logLine("PSRAM", "NOT DETECTED: set Tools > PSRAM to 'OPI PSRAM' and re-flash");
    setResult(R_PSRAM, ST_FAIL, "not detected - set Tools > PSRAM = OPI PSRAM");
    return;
  }
  const size_t N = 1048576;   // 1 MB
  uint8_t* buf = (uint8_t*)ps_malloc(N);
  if (buf == NULL) {
    logLine("PSRAM", "ps_malloc(1 MB) FAILED");
    setResult(R_PSRAM, ST_FAIL, "1 MB allocation failed");
    return;
  }
  unsigned long t0 = millis();
  for (size_t i = 0; i < N; i++) buf[i] = (uint8_t)((i * 7u) ^ 0xA5u);
  size_t errors = 0;
  for (size_t i = 0; i < N; i++) {
    if (buf[i] != (uint8_t)((i * 7u) ^ 0xA5u)) errors++;
  }
  unsigned long dt = millis() - t0;
  free(buf);
  logLine("PSRAM", "1 MB alloc + fill + verify in %lu ms, errors=%lu", dt, (unsigned long)errors);
  if (errors) setResult(R_PSRAM, ST_FAIL, "%lu verify errors in 1 MB test", (unsigned long)errors);
  else setResult(R_PSRAM, ST_PASS, "%lu MB found, 1 MB alloc/verify ok in %lu ms", (unsigned long)(size / 1048576UL), dt);
}

// ============================ PHASE A, step 7: summary =======================
static void printSummary() {
  logLine("SUMMARY", "===DIAG_SUMMARY_BEGIN===");
  for (int i = 0; i < R_COUNT; i++) {
    logLine("SUMMARY", "%-9s %s %s", g_res[i].name, stName(g_res[i].st), g_res[i].reason);
  }
  logLine("SUMMARY", "===DIAG_SUMMARY_END===");
}

// ============================ PHASE B: menu ==================================
static void printMenu() {
  logLine("MENU", "--- keys (one letter; Enter is optional) ---");
  logLine("MENU", "f=flow watch 15s  a=ADC stream 10s  l=pulse listen 10s  s=summary  h=menu");
  logLine("MENU", "1/2/3=toggle valve relay V1/V2/V3 (auto-off 20s)  P=pump (confirm 'y' in 5s)");
  logLine("MENU", "!=ALL RELAYS OFF NOW   b=cycle Serial0 baud 9600/57600/115200/230400");
}

// 'f': live table of pulses per second and the implied flow, for 15 s.
static void cmdFlowWatch() {
  logLine("PULSE", "flow watch %u s: per second, cnt = pulses (= Hz), lpm = Hz / 98 (YF-S401)",
          (unsigned)FLOW_WATCH_S);
  logLine("PULSE", "blow through a sensor or run the pump now ('!' still stops all relays)");
  pulsesReset();
  pulsesAttach();
  uint32_t prev[7] = { 0, 0, 0, 0, 0, 0, 0 };
  uint32_t now[7];
  const unsigned long t0 = millis();
  for (unsigned s = 1; s <= FLOW_WATCH_S; s++) {
    waitUntil(t0 + s * 1000UL);
    pulsesSnapshot(now);
    uint32_t d[7];
    for (uint8_t i = 0; i < 7; i++) { d[i] = now[i] - prev[i]; prev[i] = now[i]; }
    logLine("PULSE", "%02us cnt %s=%4lu %s=%4lu %s=%4lu %s=%4lu %s=%4lu %s=%4lu %s=%4lu", s,
            FLOW_SHORT[0], (unsigned long)d[0], FLOW_SHORT[1], (unsigned long)d[1], FLOW_SHORT[2], (unsigned long)d[2],
            FLOW_SHORT[3], (unsigned long)d[3], FLOW_SHORT[4], (unsigned long)d[4], FLOW_SHORT[5], (unsigned long)d[5],
            FLOW_SHORT[6], (unsigned long)d[6]);
    float l[7];
    for (uint8_t i = 0; i < 7; i++) l[i] = (float)d[i] / YF_S401_HZ_PER_LPM;
    logLine("PULSE", "%02us lpm %s=%4.2f %s=%4.2f %s=%4.2f %s=%4.2f %s=%4.2f %s=%4.2f %s=%4.2f", s,
            FLOW_SHORT[0], (double)l[0], FLOW_SHORT[1], (double)l[1], FLOW_SHORT[2], (double)l[2],
            FLOW_SHORT[3], (double)l[3], FLOW_SHORT[4], (double)l[4], FLOW_SHORT[5], (double)l[5],
            FLOW_SHORT[6], (double)l[6]);
  }
  pulsesDetach();
  logLine("PULSE", "flow watch done, totals: M=%lu 1i=%lu 1o=%lu 2i=%lu 2o=%lu 3i=%lu 3o=%lu",
          (unsigned long)now[0], (unsigned long)now[1], (unsigned long)now[2], (unsigned long)now[3],
          (unsigned long)now[4], (unsigned long)now[5], (unsigned long)now[6]);
}

// 'a': both ADC channels twice a second for 10 s (8-sample averages).
static void cmdAdcStream() {
  logLine("ADC", "streaming turbidity + TDS at 2 Hz for %u s (mV, 8-sample averages)", (unsigned)ADC_STREAM_S);
  adcSetup();
  const unsigned long t0 = millis();
  for (unsigned k = 1; k <= ADC_STREAM_S * 2; k++) {
    waitUntil(t0 + k * 500UL);
    uint32_t mvT, rawT, mvD, rawD;
    adcAverage(TURBIDITY, 8, &mvT, &rawT);
    adcAverage(TDS, 8, &mvD, &rawD);
    logLine("ADC", "t=%2u.%us TURB=%4lu mV (raw %4lu)  TDS=%4lu mV (raw %4lu)", k / 2, (k % 2) * 5,
            (unsigned long)mvT, (unsigned long)rawT, (unsigned long)mvD, (unsigned long)rawD);
  }
  logLine("ADC", "stream done");
}

// '1' '2' '3': toggle a solenoid relay.
static void cmdToggleValve(uint8_t i) {
  if (g_relay[i].on) relayOff(i, "RELAY", "toggled off by key");
  else relayOn(i);
  setResult(R_RELAYS, ST_PASS, "manually exercised; all auto-off after 20 s");
}

// 'P': pump needs a second key press. Turning it OFF never needs confirmation.
static void cmdPump() {
  if (g_relay[RELAY_PUMP_IDX].on) {
    relayOff(RELAY_PUMP_IDX, "RELAY", "toggled off by key");
    return;
  }
  logLine("RELAY", "PUMP: press 'y' within 5 s to switch ON (auto-off 20 s); any other key cancels");
  int k = waitKey(PUMP_CONFIRM_MS);
  if (k == 'y') {
    relayOn(RELAY_PUMP_IDX);
    setResult(R_RELAYS, ST_PASS, "manually exercised; all auto-off after 20 s");
  } else if (k == '!') {
    logLine("RELAY", "PUMP: cancelled by emergency key");
  } else {
    logLine("RELAY", "PUMP: not confirmed (%s), stays OFF", k < 0 ? "timeout" : "other key");
  }
}

// 'b': cycle the UART bridge baud rate. Native USB CDC ignores baud, so that side
// keeps working no matter what; announce on both ports before and after switching.
static void cmdCycleBaud() {
#if TWO_PORTS
  uint8_t next = (uint8_t)((g_baudIdx + 1) % 4);
  logLine("MENU", "Serial0 switching from %lu to %lu baud NOW - change your monitor to match",
          BAUDS[g_baudIdx], BAUDS[next]);
  Serial0.flush();
  delay(50);
  Serial0.updateBaudRate(BAUDS[next]);
  g_baudIdx = next;
  delay(50);
  logLine("MENU", "Serial0 now at %lu baud (USB CDC unaffected); press 'b' again to cycle", BAUDS[g_baudIdx]);
#else
  logLine("ERR", "USB CDC On Boot is disabled, so Serial0 is the only port; baud left at %lu", BAUDS[g_baudIdx]);
#endif
}

static void handleKey(int k) {
  switch (k) {
    case 'f': cmdFlowWatch(); break;
    case 'a': cmdAdcStream(); break;
    case '1': cmdToggleValve(0); break;
    case '2': cmdToggleValve(1); break;
    case '3': cmdToggleValve(2); break;
    case 'P': cmdPump(); break;
    case '!': allRelaysOff("emergency stop key '!'"); break;
    case 'l': phasePulseListen(); break;
    case 's': printSummary(); break;
    case 'b': cmdCycleBaud(); break;
    case 'h': break;
    default:  logLine("ERR", "unknown key '%c' (0x%02X)", k, (unsigned)(k & 0xFF)); break;
  }
  printMenu();
}

// ============================ setup / loop ===================================
void setup() {
  // ---- SAFETY FIRST: relays off before anything else runs ----
  // The relay board is ACTIVE-LOW. In core 3.x a digitalWrite() before pinMode() is
  // ignored, so preload the output latch with gpio_set_level(), then enable the output.
  for (uint8_t i = 0; i < 4; i++) {
    gpio_set_level((gpio_num_t)g_relay[i].pin, 1);
    pinMode(g_relay[i].pin, OUTPUT);
    digitalWrite(g_relay[i].pin, HIGH);
    g_relay[i].on = false;
  }

  Serial.begin(SERIAL_BAUD);
#if TWO_PORTS
  Serial.setTxTimeoutMs(0);       // never block if no USB host is reading
  Serial0.begin(SERIAL_BAUD);
#endif
  delay(200);

  // Short countdown so a serial monitor opened just after flashing still sees the banner.
  for (int i = 3; i > 0; i--) {
    logLine("BOOT", "%s starting in %d s - open the serial monitor now (115200)", SKETCH_NAME, i);
    delay(1000);
  }
  logLine("SAFE", "relay pins GPIO11-14 set OUTPUT+HIGH first: relays OFF, valves closed, pump off");

  // ---- PHASE A ----
  phaseBanner();
  phasePinSanity();
  phasePulseListen();
  phaseAdc();
  phaseWifi();
  phasePsram();
  setResult(R_RELAYS, ST_PASS, "all OFF (safe); not exercised at boot, use keys 1/2/3/P");
  printSummary();

  // ---- PHASE B ----
  logLine("MENU", "Phase A done. Paste everything above (banner to summary) back to the developer.");
  printMenu();
}

void loop() {
  relayWatchdog();
  int k = readKey();
  if (k < 0) {
    delay(5);
    return;
  }
  handleKey(k);
}
