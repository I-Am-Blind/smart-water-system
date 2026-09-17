/*
   ============================================================
              SMART WATER SYSTEM - ARDUINO UNO
   ============================================================

   FLOW SENSORS
   F1 -> D2
   F2 -> D3
   F3 -> D4
   F4 -> D5

   RELAYS
   Relay 1 -> D12
   Relay 2 -> D13

   TURBIDITY SENSOR
   AO -> A0

   GROVE TDS SENSOR
   SIG -> A1

   RELAY TYPE:
   ACTIVE LOW
   LOW  = ON
   HIGH = OFF

   ============================================================
   OPERATION
   ============================================================

   START:
   Relay 1 = OFF
   Relay 2 = ON

   Every 3 seconds:
   - Read F1, F2, F3, F4
   - Calculate difference between F3 and F4

   If difference < 30:
       Relay 1 = OFF
       Relay 2 = ON

   If difference >= 30:
       Leakage / variation detected
       Relay 2 = OFF
       Relay 1 = ON

   After Relay 1 is selected:
       Relay 1 remains ON
       Relay 2 remains OFF

   Turbidity:
       A0

   TDS:
       A1
       50-350 ppm  = LESS DISSOLVED SOLIDS
       >1000 ppm   = MORE DISSOLVED SOLIDS

   ============================================================
*/


// ============================================================
// PIN DEFINITIONS
// ============================================================

#define FLOW1_PIN 2
#define FLOW2_PIN 3
#define FLOW3_PIN 4
#define FLOW4_PIN 5

#define RELAY1_PIN 12
#define RELAY2_PIN 13

#define TURBIDITY_PIN A0
#define TDS_PIN A1

#define DIFFERENCE_LIMIT 30

#define VREF 5.0


// ============================================================
// TEMPERATURE FOR TDS
// ============================================================

float temperature = 25.0;


// ============================================================
// FLOW COUNTERS
// ============================================================

volatile unsigned long flow1Pulses = 0;
volatile unsigned long flow2Pulses = 0;
volatile unsigned long flow3Pulses = 0;
volatile unsigned long flow4Pulses = 0;

volatile byte lastPortDState;


// ============================================================
// RELAY LATCH
// ============================================================

// false = Relay 2 path
// true  = Relay 1 path permanently selected

bool alternatePathSelected = false;


// ============================================================
// RELAY FUNCTIONS
// ============================================================

void relay1ON()
{
  digitalWrite(RELAY1_PIN, LOW);
}

void relay1OFF()
{
  digitalWrite(RELAY1_PIN, HIGH);
}

void relay2ON()
{
  digitalWrite(RELAY2_PIN, LOW);
}

void relay2OFF()
{
  digitalWrite(RELAY2_PIN, HIGH);
}


// ============================================================
// FLOW 1 INTERRUPT
// ============================================================

void flow1ISR()
{
  flow1Pulses++;
}


// ============================================================
// FLOW 2 INTERRUPT
// ============================================================

void flow2ISR()
{
  flow2Pulses++;
}


// ============================================================
// FLOW 3 AND FLOW 4
// D4 AND D5 PIN CHANGE INTERRUPT
// ============================================================

ISR(PCINT2_vect)
{
  byte currentState = PIND;


  // ----------------------------------------------------------
  // FLOW 3 -> D4
  // ----------------------------------------------------------

  if ((lastPortDState & (1 << PD4)) &&
      !(currentState & (1 << PD4)))
  {
    flow3Pulses++;
  }


  // ----------------------------------------------------------
  // FLOW 4 -> D5
  // ----------------------------------------------------------

  if ((lastPortDState & (1 << PD5)) &&
      !(currentState & (1 << PD5)))
  {
    flow4Pulses++;
  }


  lastPortDState = currentState;
}


// ============================================================
// SETUP
// ============================================================

void setup()
{
  Serial.begin(9600);

  delay(1000);


  // ==========================================================
  // FLOW SENSOR INPUTS
  // ==========================================================

  pinMode(FLOW1_PIN, INPUT_PULLUP);
  pinMode(FLOW2_PIN, INPUT_PULLUP);
  pinMode(FLOW3_PIN, INPUT_PULLUP);
  pinMode(FLOW4_PIN, INPUT_PULLUP);


  // ==========================================================
  // RELAY OUTPUTS
  // ==========================================================

  pinMode(RELAY1_PIN, OUTPUT);
  pinMode(RELAY2_PIN, OUTPUT);


  // ==========================================================
  // INITIAL RELAY STATE
  // ==========================================================

  // Relay 1 OFF
  // Relay 2 ON

  relay1OFF();
  relay2ON();


  // ==========================================================
  // FLOW 1 AND FLOW 2 INTERRUPTS
  // ==========================================================

  attachInterrupt(
    digitalPinToInterrupt(FLOW1_PIN),
    flow1ISR,
    FALLING
  );

  attachInterrupt(
    digitalPinToInterrupt(FLOW2_PIN),
    flow2ISR,
    FALLING
  );


  // ==========================================================
  // FLOW 3 AND FLOW 4 PIN CHANGE INTERRUPTS
  // ==========================================================

  lastPortDState = PIND;

  PCICR |= (1 << PCIE2);

  // D4
  PCMSK2 |= (1 << PCINT20);

  // D5
  PCMSK2 |= (1 << PCINT21);


  // ==========================================================
  // START MESSAGE
  // ==========================================================

  Serial.println();
  Serial.println("================================================");
  Serial.println("          SMART WATER SYSTEM");
  Serial.println("              ARDUINO UNO");
  Serial.println("================================================");

  Serial.println();

  Serial.println("SENSORS:");
  Serial.println("F1 -> D2");
  Serial.println("F2 -> D3");
  Serial.println("F3 -> D4");
  Serial.println("F4 -> D5");
  Serial.println("Turbidity -> A0");
  Serial.println("TDS -> A1");

  Serial.println();

  Serial.println("RELAYS:");
  Serial.println("Relay 1 -> D12");
  Serial.println("Relay 2 -> D13");

  Serial.println();

  Serial.println("INITIAL STATE:");
  Serial.println("Relay 1 = OFF");
  Serial.println("Relay 2 = ON");

  Serial.println();

  Serial.print("F3/F4 Difference Limit = ");
  Serial.println(DIFFERENCE_LIMIT);

  Serial.println();

  Serial.println("Monitoring started...");
  Serial.println("================================================");
}


// ============================================================
// LOOP
// ============================================================

void loop()
{
  static unsigned long lastCheck = 0;


  // ==========================================================
  // IF ALTERNATE PATH IS ALREADY SELECTED
  // ==========================================================

  if (alternatePathSelected == true)
  {
    relay1ON();
    relay2OFF();

    /*
       Once leakage/variation is detected,
       Relay 1 stays ON and Relay 2 stays OFF.

       No further F3/F4 comparison changes the relay state.
    */

    // Still read and display sensors every 3 seconds.
  }


  // ==========================================================
  // CHECK EVERY 3 SECONDS
  // ==========================================================

  if (millis() - lastCheck >= 3000)
  {
    lastCheck = millis();


    // ========================================================
    // COPY FLOW COUNTERS SAFELY
    // ========================================================

    unsigned long f1;
    unsigned long f2;
    unsigned long f3;
    unsigned long f4;


    noInterrupts();

    f1 = flow1Pulses;
    f2 = flow2Pulses;
    f3 = flow3Pulses;
    f4 = flow4Pulses;

    flow1Pulses = 0;
    flow2Pulses = 0;
    flow3Pulses = 0;
    flow4Pulses = 0;

    interrupts();


    // ========================================================
    // CALCULATE F3/F4 DIFFERENCE
    // ========================================================

    unsigned long difference;


    if (f3 >= f4)
    {
      difference = f3 - f4;
    }
    else
    {
      difference = f4 - f3;
    }


    // ========================================================
    // READ TURBIDITY
    // ========================================================

    int turbidityRaw = analogRead(TURBIDITY_PIN);

    float turbidityVoltage =
      turbidityRaw * (5.0 / 1023.0);


    // ========================================================
    // READ TDS
    // ========================================================

    int tdsRaw = analogRead(TDS_PIN);

    float tdsVoltage =
      tdsRaw * VREF / 1023.0;


    // ========================================================
    // TDS TEMPERATURE COMPENSATION
    // ========================================================

    float compensationCoefficient =
      1.0 + 0.02 * (temperature - 25.0);


    float compensatedVoltage =
      tdsVoltage / compensationCoefficient;


    // ========================================================
    // TDS CALCULATION
    // ========================================================

    float tdsValue =
      (133.42 * compensatedVoltage * compensatedVoltage * compensatedVoltage
      - 255.86 * compensatedVoltage * compensatedVoltage
      + 857.39 * compensatedVoltage) * 0.5;


    // Prevent negative values

    if (tdsValue < 0)
    {
      tdsValue = 0;
    }


    // ========================================================
    // DISPLAY FLOW VALUES
    // ========================================================

    Serial.println();
    Serial.println("================================================");
    Serial.println("             3 SECOND READING");
    Serial.println("================================================");


    Serial.println();

    Serial.println("FLOW SENSORS");

    Serial.print("F1 = ");
    Serial.println(f1);

    Serial.print("F2 = ");
    Serial.println(f2);

    Serial.print("F3 = ");
    Serial.println(f3);

    Serial.print("F4 = ");
    Serial.println(f4);

    Serial.print("F3/F4 Difference = ");
    Serial.println(difference);

    Serial.print("Difference Limit = ");
    Serial.println(DIFFERENCE_LIMIT);


    // ========================================================
    // TURBIDITY DISPLAY
    // ========================================================

    Serial.println();

    Serial.println("TURBIDITY SENSOR");

    Serial.print("Raw ADC = ");
    Serial.println(turbidityRaw);

    Serial.print("Voltage = ");
    Serial.print(turbidityVoltage, 3);
    Serial.println(" V");


    // --------------------------------------------------------
    // TURBIDITY CLASSIFICATION
    // --------------------------------------------------------

    if (turbidityVoltage > 4.0)
    {
      Serial.println("Water condition: CLEAR WATER");
    }
    else if (turbidityVoltage > 2.5)
    {
      Serial.println(
        "Water condition: MUD AND DUST PARTICLES PRESENT"
      );
    }
    else if (turbidityVoltage > 1.5)
    {
      Serial.println("Water condition: TURBID");
    }
    else
    {
      Serial.println(
        "Water condition: HIGH SUSPENDED SOLIDS"
      );
    }


    // ========================================================
    // TDS DISPLAY
    // ========================================================

    Serial.println();

    Serial.println("GROVE TDS SENSOR");

    Serial.print("Raw ADC = ");
    Serial.println(tdsRaw);

    Serial.print("Voltage = ");
    Serial.print(tdsVoltage, 3);
    Serial.println(" V");

    Serial.print("TDS = ");
    Serial.print(tdsValue, 0);
    Serial.println(" ppm");


    // ========================================================
    // TDS WATER QUALITY CLASSIFICATION
    // ========================================================

    if (tdsValue < 50)
    {
      Serial.println(
        "Water Quality : VERY LOW DISSOLVED SOLIDS"
      );
    }
    else if (tdsValue >= 50 && tdsValue <= 350)
    {
      Serial.println(
        "Water Quality : LESS DISSOLVED SOLIDS"
      );
    }
    else if (tdsValue > 350 && tdsValue <= 1000)
    {
      Serial.println(
        "Water Quality : INTERMEDIATE DISSOLVED SOLIDS"
      );
    }
    else
    {
      Serial.println(
        "Water Quality : MORE DISSOLVED SOLIDS"
      );
    }


    // ========================================================
    // RELAY CONTROL
    // ========================================================

    Serial.println();
    Serial.println("RELAY STATUS");


    // --------------------------------------------------------
    // NORMAL PATH
    // --------------------------------------------------------

    if (alternatePathSelected == false)
    {
      if (difference < DIFFERENCE_LIMIT)
      {
        relay1OFF();
        relay2ON();

        Serial.println("STATUS: NORMAL PATH");

        Serial.println("Relay 1 = OFF");
        Serial.println("Relay 2 = ON");
      }


      // ------------------------------------------------------
      // LEAKAGE / VARIATION DETECTED
      // ------------------------------------------------------

      else
      {
        Serial.println();
        Serial.println("!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        Serial.println("  LEAKAGE / VARIATION");
        Serial.println("       DETECTED");
        Serial.println("!!!!!!!!!!!!!!!!!!!!!!!!!!!!");


        // Lock system

        alternatePathSelected = true;


        Serial.println();
        Serial.println("SWITCHING WATER PATH...");


        // ----------------------------------------------------
        // TURN RELAY 2 OFF FIRST
        // ----------------------------------------------------

        relay2OFF();

        Serial.println("Relay 2 = OFF");


        delay(300);


        // ----------------------------------------------------
        // TURN RELAY 1 ON
        // ----------------------------------------------------

        relay1ON();

        Serial.println("Relay 1 = ON");


        Serial.println();
        Serial.println("================================");
        Serial.println("   ALTERNATE PATH SELECTED");
        Serial.println("================================");

        Serial.println("Relay 1 = ON");
        Serial.println("Relay 2 = OFF");

        Serial.println();

        Serial.println("SYSTEM LOCKED");
        Serial.println("RELAY 2 WILL NOT TURN ON AGAIN");

        Serial.println("================================");
      }
    }


    // --------------------------------------------------------
    // ALREADY LOCKED
    // --------------------------------------------------------

    else
    {
      relay1ON();
      relay2OFF();

      Serial.println("STATUS: ALTERNATE PATH LOCKED");

      Serial.println("Relay 1 = ON");
      Serial.println("Relay 2 = OFF");
    }


    Serial.println();
    Serial.println("================================================");
  }
}