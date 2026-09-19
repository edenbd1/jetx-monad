/**
 * Game juice: milestone and crash wording, and synthesized sound effects (WebAudio, no assets).
 * Sounds are generated on the fly so they're tiny, instant and royalty-free.
 */

/** Multipliers celebrated during a flight (badge + pop + sparkle burst + whoosh). */
export const MILESTONES = [
  { at: 2, label: "🔥 x2", tier: 1 },
  { at: 3, label: "⚡ x3", tier: 1 },
  { at: 5, label: "🚀 EN ORBITE", tier: 2 },
  { at: 10, label: "🌕 LA LUNE", tier: 3 },
  { at: 20, label: "👽 MARS", tier: 3 },
  { at: 50, label: "🏆 MAX", tier: 4 },
] as const;

/** Slammed across the sky when the rocket blows up. */
export const CRASH_WORDS = ["💥 BOOM", "CRASH !", "EXPLOSÉ !", "KABOOM", "RIP 🪦", "ADIEU 👋", "ÇA A PÉTÉ"] as const;
export const BIG_CRASH_WORDS = ["💥 MÉGA CRASH", "APOCALYPSE", "☢️ NUCLÉAIRE"] as const;
export const WIN_WORDS = ["💸 ENCAISSÉ", "CASH OUT !", "BIEN JOUÉ", "💰 SÉCURISÉ"] as const;

export const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];

/** Multiplier colour tier: 0 white, 1 cyan (2x), 2 violet (5x), 3 gold (10x), 4 max. */
export const tierOf = (m: number) => (m >= 50 ? 4 : m >= 10 ? 3 : m >= 5 ? 2 : m >= 2 ? 1 : 0);

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  /** Must run inside a user gesture (the splash tap) for iOS. */
  unlock() {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
  }

  private ready() {
    return !this.muted && this.ctx && this.master && this.noise ? { ctx: this.ctx, out: this.master, noise: this.noise } : null;
  }

  /** The explosion: filtered noise blast + sub-bass drop + crackle. `big` for 5x+ crashes. */
  boom(big = false) {
    const a = this.ready();
    if (!a) return;
    const { ctx, out, noise } = a;
    const t = ctx.currentTime;
    const dur = big ? 2.2 : 1.5;

    const src = ctx.createBufferSource();
    src.buffer = noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(big ? 5000 : 3500, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(big ? 1.2 : 0.95, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur);

    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(big ? 110 : 90, t);
    sub.frequency.exponentialRampToValueAtTime(28, t + 0.9);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(big ? 1.1 : 0.85, t);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    sub.connect(sg).connect(out);
    sub.start(t);
    sub.stop(t + 1.2);

    // crackle tail
    for (let i = 0; i < (big ? 10 : 6); i++) {
      const c = ctx.createBufferSource();
      c.buffer = noise;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 800 + Math.random() * 2500;
      const cg = ctx.createGain();
      const at = t + 0.15 + Math.random() * (dur * 0.6);
      cg.gain.setValueAtTime(0.0001, at);
      cg.gain.exponentialRampToValueAtTime(0.35, at + 0.01);
      cg.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
      c.connect(bp).connect(cg).connect(out);
      c.start(at, Math.random());
      c.stop(at + 0.1);
    }
  }

  /** Cash register: two bright pings and a coin shimmer. */
  cashout() {
    const a = this.ready();
    if (!a) return;
    const { ctx, out } = a;
    const t = ctx.currentTime;
    [1318.5, 1760, 2637].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = i === 2 ? "triangle" : "sine";
      o.frequency.value = f;
      const g = ctx.createGain();
      const at = t + i * 0.07;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.35, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      o.connect(g).connect(out);
      o.start(at);
      o.stop(at + 0.4);
    });
  }

  /** Rising whoosh for milestones; higher tiers go higher. */
  milestone(tier: number) {
    const a = this.ready();
    if (!a) return;
    const { ctx, out, noise } = a;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 3;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(1800 + tier * 900, t + 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28 + tier * 0.06, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + 0.6);
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(520 + tier * 180, t + 0.1);
    o.frequency.exponentialRampToValueAtTime(1040 + tier * 360, t + 0.35);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t + 0.1);
    og.gain.exponentialRampToValueAtTime(0.16, t + 0.14);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(og).connect(out);
    o.start(t + 0.1);
    o.stop(t + 0.5);
  }

  /** Lift-off rumble. */
  launch() {
    const a = this.ready();
    if (!a) return;
    const { ctx, out, noise } = a;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(1400, t + 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    src.connect(lp).connect(g).connect(out);
    src.start(t);
    src.stop(t + 1.25);
  }
}

export const sfx = new Sfx();
