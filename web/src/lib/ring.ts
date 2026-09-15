/** Fixed-size ring buffer of telemetry samples, kept outside React for the chart. */
import { HZ_PER_LPM, type HistoryResponse, type Stamped, type Telemetry } from "@proto/types";

export const RING_CAPACITY = 1800; // 30 min at 1 Hz
export const SERIES = 7; // master + 3 x (in, out)

export class Ring {
  private t = new Float64Array(RING_CAPACITY);
  private v: Float64Array[] = Array.from({ length: SERIES }, () => new Float64Array(RING_CAPACITY));
  private head = 0; // next write index
  private size = 0;
  private lastAt = 0;

  clear(): void { this.head = 0; this.size = 0; this.lastAt = 0; }

  /** Seeds from /api/history (older than anything already in the ring). */
  seed(h: HistoryResponse): void {
    this.clear();
    const cols = [h.m, h.b1i, h.b1o, h.b2i, h.b2o, h.b3i, h.b3o];
    for (let i = 0; i < h.t.length; i++) {
      this.pushRaw(h.t[i], cols.map((c) => c[i] ?? 0));
    }
  }

  push(tel: Stamped<Telemetry>): boolean {
    if (tel.at <= this.lastAt) return false;
    this.pushRaw(tel.at, tel.f);
    return true;
  }

  private pushRaw(at: number, f: number[]): void {
    this.t[this.head] = at;
    for (let s = 0; s < SERIES; s++) this.v[s][this.head] = f[s] ?? 0;
    this.head = (this.head + 1) % RING_CAPACITY;
    if (this.size < RING_CAPACITY) this.size++;
    this.lastAt = at;
  }

  /** Returns uPlot-shaped data [x(seconds), s0..s6] for the last `windowMs`. */
  toData(windowMs: number, now: number = Date.now()): [number[], ...number[][]] {
    const from = now - windowMs;
    const x: number[] = [];
    const ys: number[][] = Array.from({ length: SERIES }, () => []);
    const start = (this.head - this.size + RING_CAPACITY) % RING_CAPACITY;
    for (let i = 0; i < this.size; i++) {
      const idx = (start + i) % RING_CAPACITY;
      const at = this.t[idx];
      if (at < from) continue;
      x.push(at / 1000);
      for (let s = 0; s < SERIES; s++) ys[s].push(this.v[s][idx]);
    }
    return [x, ...ys];
  }

  get length(): number { return this.size; }
}

/** Helper for labels: pulses per second implied by a flow rate. */
export function lpmToHz(lpm: number): number { return lpm * HZ_PER_LPM; }
