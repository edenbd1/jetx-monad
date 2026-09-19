import clipsJson from "@/public/kaaris/clips.json";

/** Kaaris reaction clips cut from his crash-game ad (public/kaaris). */
export type Clip = { id: string; src: string; duration: number; caption: string; trigger: string; speaker?: string };

export const CLIPS = clipsJson as Clip[];
const BY_ID = new Map(CLIPS.map((c) => [c.id, c]));
export const clipById = (id: string) => BY_ID.get(id);

/** Higher priority interrupts lower; equal priority waits in a one-slot queue. */
export const PRIORITY = { ambient: 0, reaction: 1, big: 2, intro: 3 } as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

/** Visual treatment of the facecam bubble. */
export type Mode = "normal" | "moon" | "intro";

type Threshold = { at: number; clips: string[]; priority: Priority; mode?: Mode };

// ---------------------------------------------------------------- tweak here

/** Climb reactions, each fired once per flight when the multiplier crosses `at`. */
export const CLIMB: Threshold[] = [
  { at: 1.3, clips: ["jusquau-ciel"], priority: PRIORITY.ambient },
  { at: 1.8, clips: ["monte-monte", "allez-ca-monte"], priority: PRIORITY.ambient },
  { at: 2.2, clips: ["ma-fusee"], priority: PRIORITY.reaction },
  { at: 2.5, clips: ["cest-bon-ca"], priority: PRIORITY.ambient },
  { at: 3.2, clips: ["monte-bien"], priority: PRIORITY.ambient },
  { at: 4, clips: ["je-vais-monter"], priority: PRIORITY.ambient },
  { at: 5, clips: ["thomas-pesquet"], priority: PRIORITY.big, mode: "moon" },
  { at: 7, clips: ["ah-gars"], priority: PRIORITY.reaction },
  { at: 9, clips: ["avant-quil-explose"], priority: PRIORITY.reaction },
  { at: 12, clips: ["tous-mourir"], priority: PRIORITY.reaction },
  { at: 15, clips: ["laisse-voler"], priority: PRIORITY.reaction },
  { at: 20, clips: ["visiteurs"], priority: PRIORITY.reaction },
];

export const RULES = {
  intro: "intro",
  /** Every flight starts with Kaaris: "Allez, je vais jouer 10 balles… C'est parti". */
  bet: "depart",
  /** Cash-out reactions, checked in this order. */
  cashOutSix: { clip: "je-marrete-a-6", from: 5.5, to: 6.5 },
  cashOutHuge: { clips: ["sch-incroyable", "je-suis-riche"], from: 10 },
  cashOutBig: { clip: "bim-bam-boom", from: 2 },
  cashOutTiny: { clips: ["eleonore", "ravi"], below: 1.2 },
  cashOutSmall: "vas-y-vas-y",
  /** After you cashed out: the rocket keeps going (regret), then keeps going far (Lassalle). */
  regret: { clip: "la-haine", ratio: 1.5, min: 3 },
  stillFlying: { clip: "pas-fini", ratio: 3, min: 6 },
  /** Crashes with the player on board, checked in this order. */
  instantBust: "brogniart-ah",
  firstCrash: "crash-rembourse",
  bigCrash: { clips: ["la-haine", "catastrophe"], from: 5 },
  crash: ["putain", "bravo-nils", "macron-explosion", "ravi"],
  retry: ["on-recommence", "pas-grave"],
  retryDelayMs: 1_200,
  idle: ["laisse-voler", "pas-faux"],
  idleMs: 20_000,
  broke: ["swipe-up", "la-hess"],
  climbCooldownMs: 1_500,
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

/** Decides which Kaaris clip plays when, from game events. */
export class KaarisDirector {
  private current: (Request & { token: number }) | null = null;
  private pending: Request | null = null;
  private last: string | null = null;
  private lastEndedAt = 0;
  private token = 0;
  private fired = new Set<number>();
  private regretFired = false;
  private stillFlyingFired = false;
  private crashes = 0;
  private retries = 0;
  private followUp: ReturnType<typeof setTimeout> | null = null;

  constructor(private player: ClipPlayer) {}

  // ------------------------------------------------ game hooks

  landing() {
    this.request(RULES.intro, PRIORITY.intro, "intro");
  }

  bet() {
    this.request(RULES.bet, PRIORITY.reaction);
  }

  launched() {
    // The bet line already says "c'est parti": the launch itself stays quiet.
    this.fired.clear();
    this.regretFired = false;
    this.stillFlyingFired = false;
    this.cancelFollowUp();
  }

  /** Called every frame while flying. */
  tick(multiplier: number, cashedAt: number | null) {
    if (cashedAt !== null && !this.regretFired && multiplier >= RULES.regret.min && multiplier >= cashedAt * RULES.regret.ratio) {
      this.regretFired = true;
      this.request(RULES.regret.clip, PRIORITY.big);
      return;
    }
    const far = RULES.stillFlying;
    if (cashedAt !== null && !this.stillFlyingFired && multiplier >= far.min && multiplier >= cashedAt * far.ratio) {
      this.stillFlyingFired = true;
      this.request(far.clip, PRIORITY.reaction);
      return;
    }
    // Only the highest newly crossed threshold fires (fast flights skip the smaller ones).
    let hit: Threshold | null = null;
    for (const t of CLIMB) {
      if (multiplier >= t.at && !this.fired.has(t.at)) {
        this.fired.add(t.at);
        hit = t;
      }
    }
    if (hit) this.request(hit.clips, hit.priority, hit.mode ?? "normal");
  }

  cashedOut(multiplier: number) {
    const six = RULES.cashOutSix;
    if (multiplier >= six.from && multiplier <= six.to) this.request(six.clip, PRIORITY.big);
    else if (multiplier >= RULES.cashOutHuge.from) this.request(RULES.cashOutHuge.clips, PRIORITY.big);
    else if (multiplier >= RULES.cashOutBig.from) this.request(RULES.cashOutBig.clip, PRIORITY.big);
    else if (multiplier < RULES.cashOutTiny.below) this.request(RULES.cashOutTiny.clips, PRIORITY.big);
    else this.request(RULES.cashOutSmall, PRIORITY.big);
  }

  /** The rocket blew up. `playerIn`: the player was still on board. */
  crashed(crash: number, playerIn: boolean) {
    if (!playerIn) return;
    this.crashes += 1;
    if (crash <= 1) this.request(RULES.instantBust, PRIORITY.big);
    else if (this.crashes === 1) this.request(RULES.firstCrash, PRIORITY.big);
    else if (crash >= RULES.bigCrash.from) this.request(RULES.bigCrash.clips, PRIORITY.big);
    else this.request(RULES.crash, PRIORITY.big);
    this.cancelFollowUp();
    this.followUp = setTimeout(() => {
      this.followUp = null;
      const id = RULES.retry[this.retries % RULES.retry.length];
      this.retries += 1;
      this.enqueue(id, PRIORITY.ambient);
    }, RULES.retryDelayMs);
  }

  idle() {
    this.request(RULES.idle, PRIORITY.ambient);
  }

  broke() {
    this.request(RULES.broke, PRIORITY.reaction);
  }

  stop() {
    this.cancelFollowUp();
    this.pending = null;
    if (this.current) {
      this.current = null;
      this.player.stop();
    }
  }

  // ------------------------------------------------ queue

  /** Plays now if the slot is free (or interrupts lower priority), otherwise queues or drops. */
  private request(ids: string | readonly string[], priority: Priority, mode: Mode = "normal") {
    const id = this.pick(ids, priority);
    if (!id) return;
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
    if (!clipById(id)) return;
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
    // A big moment (cash-out, crash, 5x) makes queued smaller reactions irrelevant.
    if (req.priority >= PRIORITY.big && this.pending && this.pending.priority < req.priority) this.pending = null;
    this.current = { ...req, token };
    this.last = req.id;
    this.player.play(clip, req.mode).then(() => {
      if (this.current?.token !== token) return; // interrupted
      this.current = null;
      this.lastEndedAt = Date.now();
      const next = this.pending;
      this.pending = null;
      if (next && (next.at === undefined || Date.now() - next.at < PENDING_TTL_MS)) this.start(next);
    });
  }

  /** Picks a clip, avoiding the one that just played when there's an alternative. */
  private pick(ids: string | readonly string[], priority: Priority) {
    const list = (typeof ids === "string" ? [ids] : [...ids]).filter((id) => clipById(id));
    const fresh = list.filter((id) => id !== this.last);
    // Background chatter never repeats back to back; reactions to events may.
    const pool = fresh.length ? fresh : priority === PRIORITY.ambient ? [] : list;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  private cancelFollowUp() {
    if (this.followUp) clearTimeout(this.followUp);
    this.followUp = null;
  }
}
