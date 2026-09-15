/** In-memory picture of the rig as the server currently knows it. */
import type { Brand, Hello, RigEvent, StateMsg, Stamped, Telemetry } from "@proto/types";

export const MAX_EVENTS = 50;

export class RigState {
  info: Hello | null = null;
  tel: Stamped<Telemetry> | null = null;
  /** Server time of the last telemetry; 0 = never. */
  lastTelAt = 0;
  lastSeen: number | null = null;
  online = false;
  /** Newest first, at most MAX_EVENTS. */
  events: Stamped<RigEvent>[] = [];

  constructor(public brand: Brand, public serverUrl: string) {}

  applyTel(tel: Telemetry, at: number): Stamped<Telemetry> {
    const stamped: Stamped<Telemetry> = { ...tel, at };
    this.tel = stamped;
    this.lastTelAt = at;
    this.lastSeen = at;
    return stamped;
  }

  applyEvt(evt: RigEvent, at: number): Stamped<RigEvent> {
    const stamped: Stamped<RigEvent> = { ...evt, at };
    // Replace the array so React subscribers see a new reference only when events change.
    this.events = [stamped, ...this.events].slice(0, MAX_EVENTS);
    this.lastSeen = at;
    return stamped;
  }

  snapshot(now: number = Date.now()): StateMsg {
    return {
      t: "state",
      now,
      online: this.online,
      lastSeen: this.lastSeen,
      info: this.info,
      tel: this.tel,
      events: this.events,
      brand: this.brand,
      serverUrl: this.serverUrl,
    };
  }
}
