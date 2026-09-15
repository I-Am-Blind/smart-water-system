/**
 * Synthesised sound effects + voice announcements (Web Audio + Web Speech, no assets).
 * Ported from the prototype; mute state is persisted in localStorage.
 */
type ToneSpec = {
  freq: number; duration: number; type?: OscillatorType; gain?: number;
  sweep?: number; attack?: number; release?: number;
};

const MUTE_KEY = "cascade.muted";

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private _muted = false;
  private _volume = 0.5;
  private loaded = false;

  private loadPrefs(): void {
    if (this.loaded || typeof window === "undefined") return;
    this.loaded = true;
    try { this._muted = window.localStorage.getItem(MUTE_KEY) === "1"; } catch { /* storage unavailable */ }
  }

  private ensure(): AudioContext | null {
    if (typeof window === "undefined") return null;
    this.loadPrefs();
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._muted ? 0 : this._volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  get muted(): boolean { this.loadPrefs(); return this._muted; }

  setMuted(m: boolean): void {
    this._muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this._volume;
    try { window.localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch { /* ignore */ }
    if (m) this.cancelSpeech();
  }

  /** Browsers only allow audio after a user gesture; call this from a click handler once. */
  unlock(): void { this.ensure(); }

  private tone(spec: ToneSpec): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || this._muted) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = spec.type ?? "sine";
    osc.frequency.setValueAtTime(spec.freq, ctx.currentTime);
    if (spec.sweep) osc.frequency.linearRampToValueAtTime(spec.freq + spec.sweep, ctx.currentTime + spec.duration);
    const peak = spec.gain ?? 0.3;
    const atk = spec.attack ?? 0.005;
    const rel = spec.release ?? 0.08;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(peak, ctx.currentTime + atk);
    g.gain.setValueAtTime(peak, ctx.currentTime + Math.max(atk, spec.duration - rel));
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + spec.duration);
    osc.connect(g).connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + spec.duration + 0.02);
  }

  private noise(duration: number, gain = 0.15, filterFreq = 3000): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || this._muted) return;
    const bufSize = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(this.master);
    src.start();
  }

  click(): void { this.tone({ freq: 1400, duration: 0.05, type: "square", gain: 0.08 }); }
  notify(): void {
    this.tone({ freq: 660, duration: 0.12, gain: 0.18 });
    setTimeout(() => this.tone({ freq: 990, duration: 0.14, gain: 0.18 }), 90);
  }
  success(): void {
    this.tone({ freq: 523, duration: 0.1, gain: 0.2 });
    setTimeout(() => this.tone({ freq: 784, duration: 0.15, gain: 0.2 }), 90);
  }
  warn(): void {
    this.tone({ freq: 440, duration: 0.15, type: "triangle", gain: 0.25, sweep: -80 });
    setTimeout(() => this.tone({ freq: 440, duration: 0.15, type: "triangle", gain: 0.25, sweep: -80 }), 200);
  }
  alarm(): void {
    let step = 0;
    const loop = () => {
      if (step > 5 || this._muted) return;
      this.tone({ freq: step % 2 ? 880 : 660, duration: 0.25, type: "sawtooth", gain: 0.22 });
      step++;
      setTimeout(loop, 260);
    };
    loop();
  }
  valveOpen(): void { this.tone({ freq: 200, duration: 0.4, gain: 0.18, sweep: 300 }); }
  valveClose(): void { this.tone({ freq: 500, duration: 0.4, gain: 0.18, sweep: -300 }); }
  pumpOn(): void {
    this.tone({ freq: 80, duration: 0.6, type: "sawtooth", gain: 0.2, sweep: 40 });
    this.noise(0.6, 0.05, 200);
  }
  pumpOff(): void { this.tone({ freq: 120, duration: 0.5, type: "sawtooth", gain: 0.2, sweep: -80 }); }
  burst(): void {
    this.noise(0.8, 0.35, 400);
    this.tone({ freq: 80, duration: 0.5, gain: 0.3, sweep: -40 });
    this.alarm();
  }

  speak(text: string): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    this.loadPrefs();
    if (this._muted) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.volume = Math.max(0.3, this._volume);
    const voices = window.speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => /Google|Microsoft|Samantha|Natural|Neural/i.test(v.name) && v.lang.startsWith("en")) ??
      voices.find((v) => v.lang.startsWith("en"));
    if (preferred) u.voice = preferred;
    window.speechSynthesis.speak(u);
  }

  cancelSpeech(): void {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }
}

export const audio = new AudioEngine();

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}
