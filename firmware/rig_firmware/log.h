// log.h - one logging macro for everything.
// Every line looks like  [12345][TAG] message  and goes to BOTH the native USB port (Serial)
// and the UART0 pins (Serial0), so a USB-UART adapter shows the same log as the USB cable.
#pragma once
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <stdarg.h>

static SemaphoreHandle_t g_logMutex = nullptr;

void logBegin() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);     // never block if no USB host is reading
  Serial0.begin(115200);
  g_logMutex = xSemaphoreCreateMutex();
}

// Two tasks log (loop on core 1, net task on core 0); a short mutex keeps lines whole.
void logPrintf(const char* tag, const char* fmt, ...) {
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
