import clipsJson from "@/public/kaaris/clips.json";

/** Reaction clips: Kaaris's rocket-game ad plus the French meme crew (public/kaaris). */
export type Clip = { id: string; src: string; duration: number; caption: string; trigger: string; speaker?: string };

export const CLIPS = clipsJson as Clip[];
const BY_ID = new Map(CLIPS.map((c) => [c.id, c]));
export const clipById = (id: string) => BY_ID.get(id);

/** Higher priority interrupts lower; equal priority waits in a one-slot queue. */
export const PRIORITY = { ambient: 0, reaction: 1, big: 2, intro: 3 } as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

/** Visual treatment of the facecam bubble. */
export type Mode = "normal" | "moon" | "intro" | "boom";

/** A pool of lines that fit one moment of the game; `w` biases the draw (default 1). */
type Pool = readonly (string | { readonly id: string; readonly w: number })[];

// ---------------------------------------------------------------- tweak here
//
// Every moment has a pool of lines that make sense there. The director draws from the pool at
// random, avoiding what played recently in the session, so the same moment sounds different from
// one flight to the next while always staying on topic.

export const POOLS = {
  /** Every flight starts with Kaaris placing his bet. */
  start: ["depart"],
  /** Just after lift-off, below 2x. */
  early: ["jusquau-ciel", "monte-monte", "allez-ca-monte", "cest-bon-ca", { id: "ma-fusee", w: 1.5 }],
  /** Climbing, 2x-6x. */
  climb: ["monte-bien", "je-vais-monter", "cest-bon-ca", "allez-ca-monte", "monte-monte", { id: "ma-fusee", w: 1.5 }],
  /** The orbit moment somewhere around 5x: Thomas Pesquet most of the time, else "laisse voler". */
  orbit: [{ id: "thomas-pesquet", w: 3 }, "laisse-voler"],
  /** Getting scary, 6x-12x. */
  high: ["ah-gars", "avant-quil-explose", "tous-mourir", "je-vais-monter", "monte-bien"],
  /** Deep space, 12x+. */
  space: ["tous-mourir", "visiteurs", "laisse-voler", "avant-quil-explose", "ah-gars"],
  /** The player already cashed out and the rocket keeps going. */
  afterCash: ["vas-y-vas-y", "allez-ca-monte", "monte-monte", "cest-bon-ca"],
  /** Cash-outs by size. */
  cashTiny: ["eleonore", "ravi"],
  cashSmall: ["vas-y-vas-y", "cest-bon-ca", "bim-bam-boom"],
  cashSix: [{ id: "je-marrete-a-6", w: 5 }, "bim-bam-boom"],
  cashBig: ["bim-bam-boom", "vas-y-vas-y", "je-suis-riche"],
  cashHuge: ["sch-incroyable", "je-suis-riche", "bim-bam-boom"],
  /** Watching the rocket fly on after you got out. */
  regret: ["la-haine", "pas-fini"],
  farAway: ["pas-fini", "la-haine"],
  /** Crashes with the player on board, by how far it went. */
  crashBust: [{ id: "brogniart-ah", w: 3 }, "putain", "ravi", "bravo-nils"],
  crashSmall: ["putain", "bravo-nils", "ravi", "macron-explosion", "brogniart-ah"],
  crashMid: ["putain", "macron-explosion", "bravo-nils", "catastrophe", "crash-rembourse"],
  crashBig: ["la-haine", "catastrophe", "macron-explosion", "putain"],
  /** Follow-up after a crash. */
  retry: ["on-recommence", "pas-grave", "crash-rembourse"],
  idle: ["laisse-voler", "pas-faux", "tres-simple"],
  broke: ["swipe-up", "la-hess"],
} as const satisfies Record<string, Pool>;

export const RULES = {
  intro: "intro",
  /** The orbit line fires once per flight at a random point in this range (multiplier). */
  orbitAt: [4.5, 6],
  /** Scary lines get a slot once per flight at a random point in each of these ranges. */
  highAt: [7, 10],
  spaceAt: [13, 22],
  /** Cash-out size boundaries. */
  cashTinyBelow: 1.2,
  cashSix: [5.5, 6.5],
  cashBigFrom: 2,
  cashHugeFrom: 10,
  /** After a cash-out: regret once the rocket reaches ratio x the cash-out (and min), then far away. */
  regret: { ratio: 1.5, min: 3 },
  farAway: { ratio: 3, min: 6 },
  /** Crash size boundaries (player on board). */
  crashMidFrom: 2,
  crashBigFrom: 5,
  retryDelayMs: 1_200,
  retryChance: 0.75,
  idleMs: 20_000,
  climbCooldownMs: 900,
  /** Rhythm: a new line once the cam has been quiet for a random gap in this range (ms). */
  rhythmGapMs: [700, 1_900],
  /** A line played within this many picks is heavily avoided. */
  recentWindow: 6,
} as const;

// ---------------------------------------------------------------- director

export interface ClipPlayer {
  /** Starts a clip; resolves when it ends or is stopped. Must call media play() synchronously. */
  play(clip: Clip, mode: Mode): Promise<void>;
  stop(): void;
}

type Request = { id: string; priority: Priority; mode: Mode; at?: number };

/** A queued reaction older than this is stale (the moment it reacted to has passed). */
const PENDING_TTL_MS = 2_500;

const between = (range: readonly [number, number] | readonly number[]) => range[0] + Math.random() * (range[1] - range[0]);

/** Decides which clip plays when, from game events. */
export class KaarisDirector {
  private current: (Request & { token: number }) | null = null;
  private pending: Request | null = null;
  private lastEndedAt = 0;
  private token = 0;
  /** Session-wide play history, newest last: drives the anti-repetition. */
  private history: string[] = [];
  /** Last line drawn from each pool: the same moment never repeats its previous line. */
  private lastPick = new Map<Pool, string>();
  private followUp: ReturnType<typeof setTimeout> | null = null;

  // per flight
  private flightStartedAt = 0;
  private orbitAt = 5;
  private highAt = 8;
  private spaceAt = 16;
  private fired = new Set<string>();
  private nextGap = 1_000;

  constructor(private player: ClipPlayer) {}

  // ------------------------------------------------ game hooks

  landing() {
    this.request(RULES.intro, PRIORITY.intro, "intro");
  }

  bet() {
    this.request(this.pick(POOLS.start), PRIORITY.reaction);
  }

  launched() {
    // The start line already says "c'est parti": the launch itself stays quiet.
    this.fired.clear();
    this.flightStartedAt = Date.now();
    this.orbitAt = between(RULES.orbitAt);
    this.highAt = between(RULES.highAt);
    this.spaceAt = between(RULES.spaceAt);
    this.nextGap = between(RULES.rhythmGapMs);
    this.cancelFollowUp();
  }

  /** Called every frame while flying. */
  tick(multiplier: number, cashedAt: number | null) {
    if (cashedAt !== null) {
      if (this.once("regret", multiplier >= RULES.regret.min && multiplier >= cashedAt * RULES.regret.ratio)) {
        return this.request(this.pick(POOLS.regret), PRIORITY.big);
      }
      if (this.once("far", multiplier >= RULES.farAway.min && multiplier >= cashedAt * RULES.farAway.ratio)) {
        return this.request(this.pick(POOLS.farAway), PRIORITY.reaction);
      }
    } else {
      if (this.once("orbit", multiplier >= this.orbitAt)) {
        // Reaction priority: a cash-out or a crash during the orbit line must still get its own line.
        const id = this.pick(POOLS.orbit);
        return this.request(id, PRIORITY.reaction, id === "thomas-pesquet" ? "moon" : "normal");
      }
      if (this.once("high", multiplier >= this.highAt)) return this.request(this.pick(POOLS.high), PRIORITY.reaction);
      if (this.once("space", multiplier >= this.spaceAt)) return this.request(this.pick(POOLS.space), PRIORITY.reaction);
    }
    this.keepRhythm(multiplier, cashedAt);
  }

  cashedOut(multiplier: number) {
    const pool =
      multiplier >= RULES.cashSix[0] && multiplier <= RULES.cashSix[1]
        ? POOLS.cashSix
        : multiplier >= RULES.cashHugeFrom
          ? POOLS.cashHuge
          : multiplier >= RULES.cashBigFrom
            ? POOLS.cashBig
            : multiplier < RULES.cashTinyBelow
              ? POOLS.cashTiny
              : POOLS.cashSmall;
    this.request(this.pick(pool), PRIORITY.big);
  }

  /** The rocket blew up. `playerIn`: the player was still on board. */
  crashed(crash: number, playerIn: boolean) {
    if (!playerIn) return;
    const pool =
      crash <= 1 ? POOLS.crashBust : crash >= RULES.crashBigFrom ? POOLS.crashBig : crash >= RULES.crashMidFrom ? POOLS.crashMid : POOLS.crashSmall;
    this.request(this.pick(pool), PRIORITY.big, "boom");
    this.cancelFollowUp();
    if (Math.random() > RULES.retryChance) return;
    this.followUp = setTimeout(() => {
      this.followUp = null;
      this.enqueue(this.pick(POOLS.retry), PRIORITY.ambient);
    }, RULES.retryDelayMs);
  }

  idle() {
    this.request(this.pick(POOLS.idle), PRIORITY.ambient);
  }

  broke() {
    // Usually lands while the crash line plays: queue it right after, without expiring.
    this.enqueue(this.pick(POOLS.broke), PRIORITY.reaction);
  }

  stop() {
    this.cancelFollowUp();
    this.pending = null;
    if (this.current) {
      this.current = null;
      this.player.stop();
    }
  }

  // ------------------------------------------------ choosing

  /** True the first time `cond` holds for `key` in this flight. */
  private once(key: string, cond: boolean) {
    if (!cond || this.fired.has(key)) return false;
    this.fired.add(key);
    return true;
  }

  /**
   * Weighted random draw from a pool, steering away from recent plays: the line that just played is
   * excluded, lines from the last few picks keep a small weight (so tiny pools still work), older
   * lines get their full weight.
   */
  private pick(pool: Pool): string {
    const entries = pool.map((e) => (typeof e === "string" ? { id: e, w: 1 } : e)).filter((e) => clipById(e.id));
    if (entries.length <= 1) return entries[0]?.id ?? "";
    const previous = this.lastPick.get(pool);
    const scored = entries.map((e) => {
      const last = this.history.lastIndexOf(e.id);
      const ago = last < 0 ? Infinity : this.history.length - 1 - last;
      const penalty = e.id === previous || ago === 0 ? 0 : ago < RULES.recentWindow ? 0.08 * (ago + 1) : 1;
      return { id: e.id, w: e.w * penalty };
    });
    const chosen = this.draw(scored);
    this.lastPick.set(pool, chosen);
    return chosen;
  }

  private draw(scored: { id: string; w: number }[]): string {
    const total = scored.reduce((s, e) => s + e.w, 0);
    if (total <= 0) return scored[Math.floor(Math.random() * scored.length)].id;
    let r = Math.random() * total;
    for (const e of scored) {
      r -= e.w;
      if (r <= 0) return e.id;
    }
    return scored[scored.length - 1].id;
  }

  /** Keeps a line going every couple of seconds while the rocket flies. */
  private keepRhythm(multiplier: number, cashedAt: number | null) {
    const now = Date.now();
    if (this.current || this.pending || now - this.flightStartedAt < 1_500 || now - this.lastEndedAt < this.nextGap) return;
    const pool =
      cashedAt !== null ? POOLS.afterCash : multiplier >= 12 ? POOLS.space : multiplier >= 6 ? POOLS.high : multiplier >= 2 ? POOLS.climb : POOLS.early;
    this.nextGap = between(RULES.rhythmGapMs);
    this.request(this.pick(pool), PRIORITY.ambient);
  }

  // ------------------------------------------------ queue

  /** Plays now if the slot is free (or interrupts lower priority), otherwise queues or drops. */
  private request(id: string, priority: Priority, mode: Mode = "normal") {
    if (!id || !clipById(id)) return;
    const req = { id, priority, mode };
    if (this.current) {
      if (priority > this.current.priority) return this.start(req);
      if (priority >= PRIORITY.reaction) this.keep(req);
      return;
    }
    if (priority === PRIORITY.ambient && Date.now() - this.lastEndedAt < RULES.climbCooldownMs) return;
    this.start(req);
  }

  /** Plays after whatever is on now (or right away if idle). */
  private enqueue(id: string, priority: Priority, mode: Mode = "normal") {
    if (!id || !clipById(id)) return;
    if (!this.current) return this.start({ id, priority, mode });
    this.keep({ id, priority, mode }, false);
  }

  /** `expires`: reactions go stale; explicit follow-ups (enqueue) always play. */
  private keep(req: Request, expires = true) {
    if (!this.pending || req.priority >= this.pending.priority) this.pending = { ...req, at: expires ? Date.now() : undefined };
  }

  private start(req: Request) {
    const clip = clipById(req.id);
    if (!clip) return;
    const token = ++this.token;
    // A big moment (cash-out, crash, orbit) makes queued smaller reactions irrelevant.
    if (req.priority >= PRIORITY.big && this.pending && this.pending.priority < req.priority) this.pending = null;
    this.current = { ...req, token };
    this.history.push(req.id);
    if (this.history.length > 50) this.history.shift();
    this.player.play(clip, req.mode).then(() => {
      if (this.current?.token !== token) return; // interrupted
      this.current = null;
      this.lastEndedAt = Date.now();
      const next = this.pending;
      this.pending = null;
      if (next && (next.at === undefined || Date.now() - next.at < PENDING_TTL_MS)) this.start(next);
    });
  }

  private cancelFollowUp() {
    if (this.followUp) clearTimeout(this.followUp);
    this.followUp = null;
  }
}
