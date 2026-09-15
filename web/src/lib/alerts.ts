/** Turns incoming server messages into sounds and spoken announcements. */
import type { ServerToViewer } from "@proto/types";
import { audio } from "./audio";
import { getState } from "./store";

const STALE_MS = 15_000; // do not replay old events after a reconnect

function branchName(b: number | undefined): string {
  const names = getState().brand.branches;
  return b ? (names[b - 1] ?? `branch ${b}`) : "";
}

export function onServerMessage(msg: ServerToViewer): void {
  if (msg.t === "evt") {
    if (Date.now() - msg.at > STALE_MS) return;
    switch (msg.ev) {
      case "leak":
        if (msg.kind === "burst") audio.burst(); else audio.alarm();
        audio.speak(`Warning. ${msg.kind === "burst" ? "Burst" : "Leak"} detected on ${branchName(msg.b)}. Valve closed.`);
        break;
      case "mleak":
        audio.alarm();
        audio.speak("Warning. Manifold leak detected. Pump stopped.");
        break;
      case "leak_clear":
        audio.success();
        audio.speak("Leak alarm reset.");
        break;
      case "valve":
        if (msg.on) audio.valveOpen(); else audio.valveClose();
        break;
      case "pump":
        if (msg.on) audio.pumpOn(); else audio.pumpOff();
        break;
      case "all_off":
        audio.warn();
        break;
      default:
        break;
    }
  } else if (msg.t === "device") {
    if (!msg.online) audio.notify();
  }
}
