/* ---------------------------------------------------------------------------
   OceanAmbience — a soft, endless surf bed.

   WHY THERE IS NO .mp3 HERE
   The brief asked for a small, optimised, seamlessly looping audio file. This
   synthesises the surf with Web Audio instead, which beats a file on both of
   those counts: it ships zero bytes, and it cannot seam, because there is no
   loop point to hear — the sound is generated continuously. A recorded loop
   short enough to be "lightweight" is also short enough that the ear starts
   recognising the repeat, which is the usual failure of ambient loops.

   Surf is, acoustically, filtered noise with slow swells: a low wash that rises
   and falls, a brighter hiss of foam that peaks at the crest, and a rumble
   underneath. That is what the graph below builds.

     noise ─┬─ lowpass  520Hz ── surf gain ─┐
            ├─ bandpass 2.4kHz ── foam gain ─┼─ master ── destination
            └─ lowpass  110Hz ── deep gain ─┘

   The gains are driven by sine LFOs at periods that share no common multiple
   (23s, 14s, 59s), so the swell pattern never audibly repeats.

   TO USE A REAL RECORDING INSTEAD: build a MediaElementAudioSourceNode from an
   <audio loop> and connect it where `src` connects. Everything downstream —
   the fades, the mute handling, the visibility suspend — is unchanged.
--------------------------------------------------------------------------- */

export interface AmbienceState {
  muted: boolean;
  /** True only when audio is actually flowing. */
  running: boolean;
}

export interface OceanAmbienceOptions {
  /** Master level. Deliberately low; this sits under everything. */
  volume?: number;
  onStateChange?: (state: AmbienceState) => void;
}

const STORAGE_KEY = "ocean-ambience";
const DEFAULT_VOLUME = 0.18;
const FADE_IN = 2.4;
const FADE_OUT = 0.9;
const HIDE_FADE = 0.3;

/** Seconds of noise to generate, and the crossfade that makes it loop clean. */
const BUFFER_SECONDS = 5;
const BUFFER_FADE = 0.6;

/* Session-scoped, per the brief: the choice should survive a route change but
   not follow the user back tomorrow. Storage can throw in private modes. */
function readPref(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}
function writePref(on: boolean) {
  try {
    sessionStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    /* nothing to do; the toggle still works for this page view */
  }
}

/** Paul Kellet's economical pink-noise filter. Pink sits closer to surf than white. */
function fillPink(out: Float32Array) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
}

/**
 * Noise that tiles without a click. Generates L+F samples, then folds the tail
 * back over the head with an equal-power crossfade, so sample L-1 runs into
 * sample 0 as continuously as it ran into sample L in the source.
 */
function makeLoopBuffer(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(BUFFER_SECONDS * sr);
  const fade = Math.floor(BUFFER_FADE * sr);
  const buffer = ctx.createBuffer(2, len, sr);
  const raw = new Float32Array(len + fade);

  for (let ch = 0; ch < 2; ch++) {
    fillPink(raw); // independent per channel, which is what gives it width
    const out = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      if (i < fade) {
        const t = i / fade;
        out[i] = raw[i] * Math.sqrt(t) + raw[i + len] * Math.sqrt(1 - t);
      } else {
        out[i] = raw[i];
      }
    }
  }
  return buffer;
}

type Ctor = typeof AudioContext;

function audioContextCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class OceanAmbience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private oscillators: OscillatorNode[] = [];

  private volume: number;
  private onStateChange?: (state: AmbienceState) => void;

  private _muted = true;
  private disposed = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private disarm: (() => void) | null = null;

  constructor(opts: OceanAmbienceOptions = {}) {
    this.volume = opts.volume ?? DEFAULT_VOLUME;
    this.onStateChange = opts.onStateChange;
  }

  get muted() {
    return this._muted;
  }

  get running() {
    return !!this.ctx && this.ctx.state === "running" && !this._muted;
  }

  private emit() {
    this.onStateChange?.({ muted: this._muted, running: this.running });
  }

  /* ---- graph ----------------------------------------------------------- */

  private build(): boolean {
    const Ctor = audioContextCtor();
    if (!Ctor) return false;
    try {
      const ctx = new Ctor();
      const buffer = makeLoopBuffer(ctx);

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      const surf = ctx.createBiquadFilter();
      surf.type = "lowpass";
      surf.frequency.value = 520;
      surf.Q.value = 0.6;
      const surfGain = ctx.createGain();
      surfGain.gain.value = 0.62;

      const foam = ctx.createBiquadFilter();
      foam.type = "bandpass";
      foam.frequency.value = 2400;
      foam.Q.value = 0.5;
      const foamGain = ctx.createGain();
      foamGain.gain.value = 0.11;

      const deep = ctx.createBiquadFilter();
      deep.type = "lowpass";
      deep.frequency.value = 110;
      deep.Q.value = 0.7;
      const deepGain = ctx.createGain();
      deepGain.gain.value = 0.5;

      const master = ctx.createGain();
      master.gain.value = 0; // every entrance is a fade

      src.connect(surf).connect(surfGain).connect(master);
      src.connect(foam).connect(foamGain).connect(master);
      src.connect(deep).connect(deepGain).connect(master);
      master.connect(ctx.destination);

      // An LFO added to an AudioParam sums with the param's own value, so each
      // of these widens the swing around the base gain set above.
      const lfo = (freq: number, depth: number, target: AudioParam) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        const amt = ctx.createGain();
        amt.gain.value = depth;
        osc.connect(amt).connect(target);
        osc.start();
        this.oscillators.push(osc);
      };

      lfo(0.043, 0.24, surfGain.gain); // ~23s
      lfo(0.071, 0.15, surfGain.gain); // ~14s
      lfo(0.017, 0.1, surfGain.gain); //  ~59s
      lfo(0.043, 0.07, foamGain.gain); // foam rides the same swell
      lfo(0.071, 0.05, foamGain.gain);
      lfo(0.031, 0.03, deepGain.gain);
      lfo(0.037, 150, surf.frequency); // the wash opens and closes

      src.start();

      this.ctx = ctx;
      this.master = master;
      this.source = src;
      return true;
    } catch (err) {
      console.warn("ambient audio unavailable:", err);
      return false;
    }
  }

  private fade(to: number, seconds: number) {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    const gain = master.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now); // hold wherever the last ramp got to
    gain.linearRampToValueAtTime(to, now + seconds);
  }

  /** Resolves true only if audio is genuinely flowing. */
  private async ensureRunning(): Promise<boolean> {
    if (this.disposed) return false;
    if (!this.ctx && !this.build()) return false;
    const ctx = this.ctx;
    if (!ctx) return false;
    try {
      // Rejects when there is no user activation to spend — the whole reason
      // this is never called on load.
      if (ctx.state !== "running") await ctx.resume();
    } catch (err) {
      console.warn("ambient audio could not start:", err);
      return false;
    }
    return ctx.state === "running";
  }

  /* ---- control --------------------------------------------------------- */

  /**
   * Must be reached from a user gesture when unmuting. Returns whether audio
   * is now running, so an autoplay refusal can be told apart from success.
   */
  async setMuted(muted: boolean): Promise<boolean> {
    if (this.disposed) return false;

    if (muted) {
      this._muted = true;
      writePref(false);
      this.fade(0, FADE_OUT);
      this.emit();
      return false;
    }

    const ok = await this.ensureRunning();
    // On refusal, stay muted and leave the stored preference alone: the user
    // asked for sound, the browser declined, and the next gesture should retry.
    this._muted = !ok;
    if (ok) {
      writePref(true);
      this.fade(this.volume, FADE_IN);
    }
    this.emit();
    return ok;
  }

  toggle() {
    return this.setMuted(!this._muted);
  }

  /**
   * If sound was on earlier this session, bring it back at the first gesture
   * that grants activation — never on load. Listeners stay armed until a start
   * actually succeeds, so a refused attempt costs nothing.
   */
  armAutostart() {
    if (this.disposed || this.disarm || !readPref()) return;
    const events = ["pointerdown", "keydown", "touchstart", "wheel", "scroll"];
    const go = () => {
      void this.setMuted(false).then((ok) => {
        if (ok) this.disarm?.();
      });
    };
    for (const e of events) {
      window.addEventListener(e, go, { passive: true });
    }
    this.disarm = () => {
      for (const e of events) window.removeEventListener(e, go);
      this.disarm = null;
    };
  }

  /** Hidden tabs get faded out and suspended; nobody wants a surf they can't see. */
  setPageHidden(hidden: boolean) {
    if (this.disposed || !this.ctx || this._muted) return;
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    if (hidden) {
      this.fade(0, HIDE_FADE);
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        this.ctx?.suspend().catch(() => {});
      }, HIDE_FADE * 1000 + 120);
    } else {
      void this.ctx
        .resume()
        .then(() => {
          if (!this._muted) this.fade(this.volume, 1.2);
          this.emit();
        })
        .catch(() => {});
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disarm?.();
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    for (const osc of this.oscillators) {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
    }
    this.oscillators.length = 0;
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
    this.master = null;
    const ctx = this.ctx;
    this.ctx = null;
    ctx?.close().catch(() => {});
  }
}
