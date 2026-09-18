/*
  ============================================================================
  SMART WATER SYSTEM -- ARDUINO UNO (USB)
  ============================================================================
  Speaks the device side of docs/PROTOCOL.md over USB serial: one JSON
  message per line, 115200 baud. The laptop server (web/server/serial.ts)
  reads it and serves the web dashboard and the phone app.

  Uno -> laptop   hello (at boot, and again when it receives "?")
                  tel   (once per second)
                  evt   (leak, valve, leak_clear, all_off, mode, boot)
                  ack   (one per cmd)

  laptop -> Uno   {"t":"cmd","id":7,"act":"valve","b":1,"on":true}
                  {"t":"cmd","id":8,"act":"auto","on":false}
                  act = valve | auto | all_off | reset_leak | ping
                  There is no pump relay on this board: "pump" is refused.
                  A line with just "?" asks for hello again.

  PIN MAP
  ---------------------------------------------------------------------------
  Flow IN      D5   bench label F4   pin-change interrupt
  Flow OUT     D4   bench label F3   pin-change interrupt
  Valve 1      D9   branch 1, normal path     relay ACTIVE LOW
  Valve 2      D8   branch 2, alternate path  relay ACTIVE LOW
  Turbidity    A0
  TDS          A1

  BEHAVIOUR
  ---------------------------------------------------------------------------
  Every second the IN and OUT pulses of the last 3 s are compared. A
  difference of 30 pulses or more latches a leak, in either mode. Only one
  valve is open at a time (300 ms break-before-make between them).

  AUTO (at boot)  Normal path (valve 1) open. A leak closes valve 1 and
                  opens valve 2. reset_leak goes back to valve 1. Valve
                  commands are refused with "auto_mode".
  MANUAL          Leaks are still detected and reported; nothing switches
                  on its own. Valve commands open and close the valves.
                  all_off always switches to MANUAL and closes both.

  The loss % sent to the dashboard is from the last second, so it follows
  the water without lagging the 3 s window.
  ============================================================================
*/

#include <Arduino.h>

#if !defined(__AVR_ATmega328P__)
#error "Flow pins use ATmega328P pin-change interrupts (Uno / Nano)."
#endif


// ============================================================================
// PIN CONFIGURATION
// ============================================================================

// Both flow pins must be on PORTD (D0-D7): there the port bit and the
// PCMSK2 bit are both equal to the pin number.
const byte FLOW_IN_PIN = 5;
const byte FLOW_OUT_PIN = 4;

const byte VALVE1_PIN = 9;
const byte VALVE2_PIN = 8;

const byte TURBIDITY_PIN = A0;
const byte TDS_PIN = A1;


// ============================================================================
// SETTINGS
// ============================================================================

#define FW_VERSION "3.0.0-uno"

const unsigned long TEL_PERIOD_MS = 1000UL;

// Leak check: IN vs OUT pulses summed over the last LEAK_WINDOW_S seconds
const byte LEAK_WINDOW_S = 3;
const unsigned long LEAK_LIMIT_PULSES = 30UL;
const unsigned long LEAK_WARN_PULSES = 15UL;   // shown as "warn", no action
const float LEAK_BURST_PCT = 50.0F;            // latched leak at/above this = burst, else drip

// Ignore the check this long after valve 1 opens or closes (flow settling)
const unsigned long SETTLE_MS = 4000UL;

const unsigned long FAILOVER_BREAK_MS = 300UL;

// YF-S401: pulses per second = 98 x L/min
const float HZ_PER_LPM = 98.0F;


// If the analog sensor output goes directly to A0/A1 and is guaranteed
// to stay within 0-5V, use 1.0.
//
// If you use the same 10k/20k divider from the original ESP32 circuit:
//
// SENSOR OUT --- 10K ---+--- 20K --- GND
//                       |
//                      A0/A1
//
// use 1.5.
const float ANALOG_DIVIDER_RATIO = 1.0F;


// TDS temperature compensation
const float TDS_TEMPERATURE_C = 25.0F;


// ============================================================================
// FLOW COUNTERS
// ============================================================================

volatile unsigned long inPulses = 0;
volatile unsigned long outPulses = 0;

// Last PORTD level seen by the pin-change ISR, used to find falling edges
volatile byte lastPortD = 0xFF;

unsigned long totalIn = 0;
unsigned long totalOut = 0;

// Pulses per second for the last LEAK_WINDOW_S seconds
unsigned long winIn[LEAK_WINDOW_S];
unsigned long winOut[LEAK_WINDOW_S];
byte winPos = 0;
byte winFill = 0;


// ============================================================================
// VALVES
// ============================================================================

bool valveOn[2] = { false, false };

// Branch waiting to open after the break-before-make pause, 0 = none
byte pendingValve = 0;
unsigned long pendingAtMs = 0;
const char *pendingSrc = "";
const char *pendingReason = NULL;

unsigned long valve1ChangedMs = 0;


// ============================================================================
// STATE
// ============================================================================

bool autoMode = true;

bool leakLatched = false;
bool leakBurst = false;

unsigned long telSeq = 0;
unsigned long lastTickMs = 0;


// ============================================================================
// FLOW INTERRUPT
// ============================================================================

// D4 and D5 are not external-interrupt pins on the Uno, so they share the
// PORTD pin-change vector. Only these two pins are unmasked.
ISR(PCINT2_vect)
{
  byte now = PIND;
  byte fell = lastPortD & (byte)~now;

  lastPortD = now;

  if (fell & _BV(FLOW_IN_PIN))
    inPulses++;

  if (fell & _BV(FLOW_OUT_PIN))
    outPulses++;
}


// ============================================================================
// SMALL HELPERS
// ============================================================================

int freeRam()
{
  extern int __heap_start;
  extern int *__brkval;

  int v;

  return (int)&v - (__brkval == 0 ? (int)&__heap_start : (int)__brkval);
}


void printQuoted(const char *s)
{
  Serial.print('"');
  Serial.print(s);
  Serial.print('"');
}


// ============================================================================
// OUTGOING MESSAGES
// ============================================================================

void sendHello()
{
  Serial.println(F("{\"t\":\"hello\",\"proto\":1,\"id\":\"uno\",\"fw\":\"" FW_VERSION "\","
                   "\"ip\":\"usb\",\"rssi\":0,\"rst\":\"UNKNOWN\",\"mon\":[1,0],\"sim\":false}"));
}


// {"t":"evt","ms":N,"ev":"<ev>"   ... caller adds fields, then evtEnd()
void evtStart(const __FlashStringHelper *ev)
{
  Serial.print(F("{\"t\":\"evt\",\"ms\":"));
  Serial.print(millis());
  Serial.print(F(",\"ev\":\""));
  Serial.print(ev);
  Serial.print('"');
}


void evtEnd(const char *src, const char *reason)
{
  Serial.print(F(",\"src\":"));
  printQuoted(src);

  if (reason)
  {
    Serial.print(F(",\"reason\":"));
    printQuoted(reason);
  }

  Serial.println('}');
}


void sendAck(unsigned long id, const char *err)
{
  Serial.print(F("{\"t\":\"ack\",\"id\":"));
  Serial.print(id);

  if (err)
  {
    Serial.print(F(",\"ok\":false,\"err\":"));
    printQuoted(err);
  }
  else
  {
    Serial.print(F(",\"ok\":true,\"ms\":"));
    Serial.print(millis());
  }

  Serial.println('}');
}


// ============================================================================
// VALVE CONTROL
// ============================================================================

void setValve(byte b, bool on, const char *src, const char *reason)
{
  // Relay module is ACTIVE LOW
  digitalWrite(b == 1 ? VALVE1_PIN : VALVE2_PIN, on ? LOW : HIGH);

  if (valveOn[b - 1] == on)
    return;

  valveOn[b - 1] = on;

  if (b == 1)
    valve1ChangedMs = millis();

  evtStart(F("valve"));
  Serial.print(F(",\"b\":"));
  Serial.print(b);
  Serial.print(F(",\"on\":"));
  Serial.print(on ? 1 : 0);
  evtEnd(src, reason);
}


// Opens branch b. The other valve closes first and b opens after the
// break-before-make pause (see valveService).
void openValve(byte b, const char *src, const char *reason)
{
  // Already waiting to open this one
  if (pendingValve == b)
    return;

  // The other branch was waiting to open: it never did, drop it
  pendingValve = 0;

  byte other = (b == 1) ? 2 : 1;

  if (valveOn[other - 1])
  {
    setValve(other, false, src, NULL);

    pendingValve = b;
    pendingAtMs = millis();
    pendingSrc = src;
    pendingReason = reason;
  }
  else
  {
    setValve(b, true, src, reason);
  }
}


void closeValve(byte b, const char *src)
{
  if (pendingValve == b)
    pendingValve = 0;

  setValve(b, false, src, NULL);
}


void valveService()
{
  if (pendingValve == 0)
    return;

  if ((unsigned long)(millis() - pendingAtMs) >= FAILOVER_BREAK_MS)
  {
    byte b = pendingValve;

    pendingValve = 0;

    setValve(b, true, pendingSrc, pendingReason);
  }
}


// ============================================================================
// MODE
// ============================================================================

// Automatic mode: the normal path, or the alternate one while a leak is latched
void applyAuto(const char *src)
{
  if (leakLatched)
    openValve(2, src, NULL);
  else
    openValve(1, src, NULL);
}


void setMode(bool automatic, const char *src)
{
  if (autoMode == automatic)
    return;

  autoMode = automatic;

  evtStart(F("mode"));
  Serial.print(F(",\"on\":"));
  Serial.print(automatic ? 1 : 0);
  evtEnd(src, NULL);
}


// ============================================================================
// LEAK
// ============================================================================

void latchLeak(float loss)
{
  leakLatched = true;
  leakBurst = loss >= LEAK_BURST_PCT;

  evtStart(F("leak"));
  Serial.print(F(",\"b\":1,\"kind\":"));
  printQuoted(leakBurst ? "burst" : "drip");
  Serial.print(F(",\"loss\":"));
  Serial.print(loss, 1);
  evtEnd("leak", NULL);

  // Close the normal path, then open the alternate one
  if (autoMode)
    openValve(2, "leak", "failover");
}


// ============================================================================
// ANALOG SENSORS
// ============================================================================

// Millivolts at the pin, 8 reads averaged
int readPinMv(byte pin)
{
  long sum = 0;

  for (byte i = 0; i < 8; i++)
    sum += analogRead(pin);

  return (int)((sum * 5000L) / (8L * 1023L));
}


int turbidityNtu(int pinMv)
{
  float v = (pinMv / 1000.0F) * ANALOG_DIVIDER_RATIO;

  if (v > 4.2F)
    return 0;

  float ntu = -1120.4F * v * v + 5742.3F * v - 4352.9F;

  if (ntu < 0.0F)
    ntu = 0.0F;

  if (ntu > 3000.0F)
    ntu = 3000.0F;

  return (int)ntu;
}


int tdsPpm(int pinMv)
{
  float voltage = (pinMv / 1000.0F) * ANALOG_DIVIDER_RATIO;

  float compensationCoefficient =
    1.0F + 0.02F * (TDS_TEMPERATURE_C - 25.0F);

  float v = voltage / compensationCoefficient;

  float ppm =
    (133.42F * v * v * v - 255.86F * v * v + 857.39F * v) * 0.5F;

  if (ppm < 0.0F)
    ppm = 0.0F;

  return (int)(ppm + 0.5F);
}


// ============================================================================
// ONE SAMPLE PER SECOND
// ============================================================================

void tick()
{
  // --------------------------------------------------------------------------
  // FLOW
  // --------------------------------------------------------------------------

  noInterrupts();

  unsigned long in = inPulses;
  unsigned long out = outPulses;

  inPulses = 0;
  outPulses = 0;

  interrupts();


  totalIn += in;
  totalOut += out;

  winIn[winPos] = in;
  winOut[winPos] = out;
  winPos = (winPos + 1) % LEAK_WINDOW_S;

  if (winFill < LEAK_WINDOW_S)
    winFill++;


  unsigned long wIn = 0;
  unsigned long wOut = 0;

  for (byte i = 0; i < winFill; i++)
  {
    wIn += winIn[i];
    wOut += winOut[i];
  }


  unsigned long diff = (wIn >= wOut) ? wIn - wOut : wOut - wIn;


  // Loss % over the last second (IN vs OUT, whichever is larger)
  unsigned long diffNow = (in >= out) ? in - out : out - in;
  unsigned long biggerNow = (in >= out) ? in : out;

  float loss = biggerNow > 0 ? (diffNow * 100.0F) / biggerNow : 0.0F;


  // --------------------------------------------------------------------------
  // LEAK CHECK
  // --------------------------------------------------------------------------

  bool checking =
    valveOn[0] &&
    winFill == LEAK_WINDOW_S &&
    (unsigned long)(millis() - valve1ChangedMs) >= SETTLE_MS;

  if (!leakLatched && checking && diff >= LEAK_LIMIT_PULSES)
    latchLeak(loss);


  byte level;

  if (leakLatched)
    level = leakBurst ? 3 : 2;
  else if (checking && diff >= LEAK_WARN_PULSES)
    level = 1;
  else
    level = 0;


  // --------------------------------------------------------------------------
  // ANALOG
  // --------------------------------------------------------------------------

  int turbMv = readPinMv(TURBIDITY_PIN);
  int tdsMv = readPinMv(TDS_PIN);


  // --------------------------------------------------------------------------
  // TELEMETRY
  // --------------------------------------------------------------------------

  float periodS = TEL_PERIOD_MS / 1000.0F;

  Serial.print(F("{\"t\":\"tel\",\"ms\":"));
  Serial.print(millis());

  Serial.print(F(",\"seq\":"));
  Serial.print(++telSeq);

  Serial.print(F(",\"f\":["));
  Serial.print(in / periodS / HZ_PER_LPM, 2);
  Serial.print(',');
  Serial.print(out / periodS / HZ_PER_LPM, 2);

  Serial.print(F("],\"p\":["));
  Serial.print(totalIn);
  Serial.print(',');
  Serial.print(totalOut);

  Serial.print(F("],\"loss\":["));
  Serial.print(loss, 1);

  Serial.print(F(",0],\"leak\":["));
  Serial.print(level);

  Serial.print(F(",0],\"v\":["));
  Serial.print(valveOn[0] ? 1 : 0);
  Serial.print(',');
  Serial.print(valveOn[1] ? 1 : 0);

  Serial.print(F("],\"pump\":0,\"auto\":"));
  Serial.print(autoMode ? 1 : 0);

  Serial.print(F(",\"turb\":{\"mv\":"));
  Serial.print(turbMv);
  Serial.print(F(",\"ntu\":"));
  Serial.print(turbidityNtu(turbMv));

  Serial.print(F("},\"tds\":{\"mv\":"));
  Serial.print(tdsMv);
  Serial.print(F(",\"ppm\":"));
  Serial.print(tdsPpm(tdsMv));

  Serial.print(F("},\"rssi\":0,\"up\":"));
  Serial.print(millis() / 1000UL);

  Serial.print(F(",\"heap\":"));
  Serial.print(freeRam());

  Serial.println(F(",\"sim\":false}"));
}


// ============================================================================
// INCOMING COMMANDS
// ============================================================================

// Points just past "key": (and any spaces) in line, or NULL.
const char *jsonValue(const char *line, const char *key)
{
  char pattern[16];
  byte n = strlen(key);

  if (n > sizeof(pattern) - 4)
    return NULL;

  pattern[0] = '"';
  memcpy(pattern + 1, key, n);
  pattern[n + 1] = '"';
  pattern[n + 2] = ':';
  pattern[n + 3] = '\0';

  const char *p = strstr(line, pattern);

  if (!p)
    return NULL;

  p += n + 3;

  while (*p == ' ')
    p++;

  return p;
}


// True when "key" holds the string value str.
bool jsonIs(const char *line, const char *key, const char *str)
{
  const char *p = jsonValue(line, key);

  if (!p || *p != '"')
    return false;

  byte n = strlen(str);

  return strncmp(p + 1, str, n) == 0 && p[n + 1] == '"';
}


void handleLine(const char *line)
{
  if (strcmp(line, "?") == 0)
  {
    sendHello();
    return;
  }

  // Only commands matter; welcome and anything else is ignored
  if (!jsonIs(line, "t", "cmd"))
    return;

  const char *idp = jsonValue(line, "id");

  if (!idp || !isdigit(*idp))
    return;

  unsigned long id = strtoul(idp, NULL, 10);


  // --------------------------------------------------------------------------
  // VALVE
  // --------------------------------------------------------------------------

  if (jsonIs(line, "act", "valve"))
  {
    if (autoMode)
    {
      sendAck(id, "auto_mode");
      return;
    }

    const char *bp = jsonValue(line, "b");
    byte b = bp ? (byte)atoi(bp) : 0;

    if (b != 1 && b != 2)
    {
      sendAck(id, "bad_branch");
      return;
    }

    const char *onp = jsonValue(line, "on");
    bool on = onp && strncmp(onp, "true", 4) == 0;

    if (on)
      openValve(b, "ws", NULL);
    else
      closeValve(b, "ws");

    sendAck(id, NULL);
  }


  // --------------------------------------------------------------------------
  // AUTO / MANUAL
  // --------------------------------------------------------------------------

  else if (jsonIs(line, "act", "auto"))
  {
    const char *onp = jsonValue(line, "on");

    setMode(onp && strncmp(onp, "true", 4) == 0, "ws");

    if (autoMode)
      applyAuto("ws");

    sendAck(id, NULL);
  }


  // --------------------------------------------------------------------------
  // ALL OFF (manual mode, both valves closed)
  // --------------------------------------------------------------------------

  else if (jsonIs(line, "act", "all_off"))
  {
    setMode(false, "ws");

    pendingValve = 0;

    closeValve(1, "ws");
    closeValve(2, "ws");

    evtStart(F("all_off"));
    evtEnd("ws", NULL);

    sendAck(id, NULL);
  }


  // --------------------------------------------------------------------------
  // RESET LEAK
  // --------------------------------------------------------------------------

  else if (jsonIs(line, "act", "reset_leak"))
  {
    if (leakLatched)
    {
      leakLatched = false;

      evtStart(F("leak_clear"));
      evtEnd("ws", NULL);
    }

    // Back to the normal path
    if (autoMode)
      applyAuto("ws");

    sendAck(id, NULL);
  }


  // --------------------------------------------------------------------------
  // PING
  // --------------------------------------------------------------------------

  else if (jsonIs(line, "act", "ping"))
  {
    sendAck(id, NULL);
  }


  // --------------------------------------------------------------------------
  // UNKNOWN (includes "pump": this board has no pump relay)
  // --------------------------------------------------------------------------

  else
  {
    sendAck(id, "unknown_act");
  }
}


void serialService()
{
  static char line[96];
  static byte len = 0;
  static bool overflow = false;

  while (Serial.available())
  {
    char c = (char)Serial.read();

    if (c == '\n' || c == '\r')
    {
      if (len > 0 && !overflow)
      {
        line[len] = '\0';
        handleLine(line);
      }

      len = 0;
      overflow = false;
    }
    else if (len < sizeof(line) - 1)
    {
      line[len++] = c;
    }
    else
    {
      // Too long for any valid command: drop the whole line
      overflow = true;
    }
  }
}


// ============================================================================
// SETUP
// ============================================================================

void setup()
{
  // Relays OFF before the pins become outputs (active low)
  digitalWrite(VALVE1_PIN, HIGH);
  digitalWrite(VALVE2_PIN, HIGH);

  pinMode(VALVE1_PIN, OUTPUT);
  pinMode(VALVE2_PIN, OUTPUT);


  pinMode(FLOW_IN_PIN, INPUT_PULLUP);
  pinMode(FLOW_OUT_PIN, INPUT_PULLUP);

  pinMode(TURBIDITY_PIN, INPUT);
  pinMode(TDS_PIN, INPUT);


  Serial.begin(115200);


  // Flow pulses on the PORTD pin-change interrupt
  noInterrupts();

  lastPortD = PIND;

  PCMSK2 |= _BV(FLOW_IN_PIN) | _BV(FLOW_OUT_PIN);
  PCIFR = _BV(PCIF2);
  PCICR |= _BV(PCIE2);

  interrupts();


  sendHello();

  evtStart(F("boot"));
  evtEnd("boot", NULL);


  // Automatic mode: start the normal water path
  applyAuto("boot");


  lastTickMs = millis();
}


// ============================================================================
// MAIN LOOP
// ============================================================================

void loop()
{
  serialService();

  valveService();

  if ((unsigned long)(millis() - lastTickMs) >= TEL_PERIOD_MS)
  {
    lastTickMs += TEL_PERIOD_MS;

    tick();
  }
}
