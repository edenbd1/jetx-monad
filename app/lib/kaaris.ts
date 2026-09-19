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

/** A pool of lines that fit one moment of the game; `w` = copies of that line in the pool's deck (default 1). */
type Pool = readonly (string | { readonly id: string; readonly w: number })[];

// ---------------------------------------------------------------- tweak here
//
// Every moment has a pool of lines that make sense there. Each pool is dealt like a shuffled deck
// kept on the device: every line of the pool plays before one comes back, a line never plays twice
// in the same flight, and nothing that played in the last few picks comes back, so the same moment
// sounds different from one flight (and one game) to the next while always staying on topic.

export const POOLS = {
  /** Every flight starts with Kaaris placing his bet. */
  start: ["depart"],
  /** Just after lift-off, below 2x. */
  early: ["jusquau-ciel", "monte-monte", "allez-ca-monte", "cest-bon-ca", "ma-fusee", "oh-la-la", "enorme", "infini", "cest-parti", "celle-la-bonne", "okay"],
  /** Climbing, 2x-6x. */
  climb: ["monte-bien", "je-vais-monter", "cest-bon-ca", "allez-ca-monte", "monte-monte", "ma-fusee", "oh-la-la", "enorme", "infini", "dinguerie", "magnifique", "celle-la-bonne", "okay", "jcvd"],
  /** The orbit moment somewhere around 5x: Thomas Pesquet most of the time, else Buzz or "laisse voler". */
  orbit: [{ id: "thomas-pesquet", w: 4 }, { id: "infini", w: 1.5 }, "laisse-voler"],
  /** Getting scary, 6x-12x. */
  high: ["ah-gars", "avant-quil-explose", "tous-mourir", "ca-va-peter", "dernier-mot", "je-vais-monter", "monte-bien", "oh-la-la", "enorme"],
  /** Deep space, 12x+. */
  space: ["tous-mourir", "visiteurs", "laisse-voler", "avant-quil-explose", "ah-gars", "ca-va-peter", "dernier-mot", "infini", "dinguerie"],
  /** The player already cashed out and the rocket keeps going. */
  afterCash: ["vas-y-vas-y", "allez-ca-monte", "monte-monte", "cest-bon-ca", "oh-la-la", "enorme", "valide", "magnifique", "okay"],
  /** Cash-outs by size. */
  cashTiny: ["eleonore", "ravi", "rigolo", "cest-cela-oui"],
  cashSmall: ["vas-y-vas-y", "cest-bon-ca", "bim-bam-boom", "valide", "magnifique", "okay"],
  cashSix: [{ id: "je-marrete-a-6", w: 5 }, "bim-bam-boom"],
  cashBig: ["bim-bam-boom", "vas-y-vas-y", "je-suis-riche", "magnifique", "dinguerie", "valide"],
  cashHuge: ["sch-incroyable", "je-suis-riche", "mourir-tranquille", "dinguerie", "magnifique"],
  /** Watching the rocket fly on after you got out. */
  regret: ["la-haine", "pas-fini"],
  farAway: ["pas-fini", "la-haine"],
  /** Crashes with the player on board, by how far it went. */
  // "Super… pour l'appareil photo" (Nils) is the crowd favourite: two cards in every crash deck.
  crashBust: [
    { id: "brogniart-ah", w: 2 },
    { id: "bravo-nils", w: 2 },
    "putain",
    "ravi",
    "coup-dur",
    "rigolo",
    "maillon-faible",
    "coffe-merde",
    "au-revoir",
    "pas-de-bras",
    "visiteurs-binz",
  ],
  crashSmall: [
    { id: "bravo-nils", w: 2 },
    "putain",
    "ravi",
    "macron-explosion",
    "brogniart-ah",
    "boulette",
    "coup-dur",
    "rigolo",
    "maillon-faible",
    "coffe-merde",
    "au-revoir",
    "houston",
    "cest-cela-oui",
    "pas-de-bras",
  ],
  crashMid: [
    { id: "bravo-nils", w: 2 },
    "putain",
    "macron-explosion",
    "catastrophe",
    "crash-rembourse",
    "boulette",
    "coup-dur",
    "sentence-irrevocable",
    "monde-de-merde",
    "houston",
    "etchebest",
    "visiteurs-binz",
    "maillon-faible",
  ],
  crashBig: [
    { id: "bravo-nils", w: 2 },
    "la-haine",
    "catastrophe",
    "macron-explosion",
    "putain",
    "boulette",
    "sentence-irrevocable",
    "monde-de-merde",
    "etchebest",
    "visiteurs-binz",
    "houston",
  ],
  /** Follow-up after a crash. */
  retry: ["on-recommence", "pas-grave", "crash-rembourse", "malentendu"],
  idle: ["laisse-voler", "pas-faux", "tres-simple", "bonne-situation", "cest-cela-oui"],
  broke: ["swipe-up", "la-hess", "malentendu", "pas-de-bras"],
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
  /** After the crash line: sometimes a second crash reaction, then (often) an invitation to go again. */
  crashEncoreChance: 0.5,
  retryChance: 0.8,
  idleMs: 20_000,
  climbCooldownMs: 150,
  /** Rhythm: during a flight there's (almost) always a meme on screen: the next one starts after a short random pause (ms). */
  rhythmGapMs: [150, 500],
  /** A line played within this many picks is skipped while the deck has anything else (persists across games). */
  recentWindow: 8,
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

const POOL_NAME = new Map<Pool, string>(Object.entries(POOLS).map(([name, pool]) => [pool as Pool, name]));

/** Where a pool borrows from once all its own lines played in this flight (same mood only). */
const HYPE: Pool = [...POOLS.early, ...POOLS.climb, ...POOLS.afterCash, ...POOLS.orbit];
const SCARY: Pool = [...POOLS.high, ...POOLS.space, ...HYPE];
const SPILL = new Map<Pool, Pool>([
  [POOLS.early, HYPE],
  [POOLS.climb, HYPE],
  [POOLS.afterCash, [...HYPE, ...POOLS.cashSmall, ...POOLS.cashBig, ...POOLS.cashHuge, ...POOLS.regret]],
  [POOLS.high, SCARY],
  [POOLS.space, SCARY],
  [POOLS.crashBust, [...POOLS.crashSmall, ...POOLS.crashMid]],
  [POOLS.crashSmall, [...POOLS.crashBust, ...POOLS.crashMid]],
  [POOLS.crashMid, [...POOLS.crashSmall, ...POOLS.crashBig]],
  [POOLS.crashBig, [...POOLS.crashMid]],
]);

/**
 * What this device has already seen, kept in localStorage so the next game (even after a reload)
 * carries on each deck where it stopped instead of replaying the same lines.
 */
const MEMORY_KEY = "fusee-memes-v2";
type Memory = { decks: Record<string, string[]>; seen: Record<string, number>; plays: number };

function loadMemory(): Memory {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(MEMORY_KEY) : null;
    if (raw) {
      const m = JSON.parse(raw) as Partial<Memory>;
      return { decks: m.decks ?? {}, seen: m.seen ?? {}, plays: typeof m.plays === "number" ? m.plays : 0 };
    }
  } catch {
    // unreadable storage: start fresh
  }
  return { decks: {}, seen: {}, plays: 0 };
}

const entriesOf = (pool: Pool) => pool.map((e) => (typeof e === "string" ? { id: e, w: 1 } : e)).filter((e) => clipById(e.id));

function shuffle<T>(list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const between = (range: readonly [number, number] | readonly number[]) => range[0] + Math.random() * (range[1] - range[0]);

/** Decides which clip plays when, from game events. */
export class KaarisDirector {
  private current: (Request & { token: number }) | null = null;
  private pending: Request | null = null;
  private lastEndedAt = 0;
  private token = 0;
  /** Remaining cards of each pool's deck, persisted per device. */
  private decks: Record<string, string[]>;
  /** Play counter value when each line last played (per device), and the counter. */
  private seen: Record<string, number>;
  private plays: number;
  /** Explicit follow-ups (second crash line, retry, broke) played in order once the cam is free. */
  private queue: Request[] = [];
  /** Lines already played since this flight's bet: none plays twice in a flight. */
  private flightPlayed = new Set<string>();

  // per flight
  private flightStartedAt = 0;
  private orbitAt = 5;
  private highAt = 8;
  private spaceAt = 16;
  private fired = new Set<string>();
  private nextGap = 1_000;

  constructor(private player: ClipPlayer) {
    const memory = loadMemory();
    this.decks = memory.decks;
    this.seen = memory.seen;
    this.plays = memory.plays;
  }

  private saveMemory() {
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify({ decks: this.decks, seen: this.seen, plays: this.plays } satisfies Memory));
    } catch {
      // storage full or blocked: the in-memory history still works for this game
    }
  }

  // ------------------------------------------------ game hooks

  landing() {
    this.request(RULES.intro, PRIORITY.intro, "intro");
  }

  bet() {
    this.queue = [];
    this.flightPlayed.clear();
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
    this.queue = [];
    this.request(this.pick(pool), PRIORITY.big, "boom");
    // Explicit follow-ups, in order: another take on the crash, then an invitation to go again.
    if (Math.random() < RULES.crashEncoreChance) this.enqueue(this.pick(pool), PRIORITY.reaction);
    if (Math.random() < RULES.retryChance) this.enqueue(this.pick(POOLS.retry), PRIORITY.ambient);
  }

  idle() {
    this.request(this.pick(POOLS.idle), PRIORITY.ambient);
  }

  broke() {
    // Usually lands while the crash line plays: queue it right after, without expiring.
    this.enqueue(this.pick(POOLS.broke), PRIORITY.reaction);
  }

  stop() {
    this.pending = null;
    this.queue = [];
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
   * Deals the next line of a pool's deck. Cards are skipped (not discarded) while they already
   * played in this flight or within the last few picks; once every card of the pool played in this
   * flight, the pool borrows an unplayed line of the same mood. An empty deck is reshuffled with
   * every line of the pool (`w` copies each), never starting with the line that just played.
   */
  private pick(pool: Pool): string {
    const entries = entriesOf(pool);
    if (entries.length <= 1) return entries[0]?.id ?? "";
    const name = POOL_NAME.get(pool) ?? "";
    const ids = new Set(entries.map((e) => e.id));
    const unplayed = (id: string) => !this.flightPlayed.has(id);
    let deck = (this.decks[name] ?? []).filter((id) => ids.has(id));
    if (!deck.some(unplayed) && entries.some((e) => unplayed(e.id))) {
      const inDeck = new Set(deck);
      const fresh = shuffle(entries.filter((e) => !inDeck.has(e.id)).flatMap((e) => Array<string>(Math.max(1, Math.round(e.w))).fill(e.id)));
      if (fresh.length > 1 && fresh[0] === this.lastPlayed()) fresh.push(fresh.shift() as string);
      deck = [...deck, ...fresh];
    }
    const recent = (id: string) => this.seen[id] !== undefined && this.plays - this.seen[id] <= RULES.recentWindow;
    let at = deck.findIndex((id) => unplayed(id) && !recent(id));
    if (at < 0) at = deck.findIndex(unplayed);
    let chosen: string;
    if (at >= 0) {
      chosen = deck[at];
      deck.splice(at, 1);
    } else {
      chosen = this.borrow(pool) ?? this.leastRecent(entries.map((e) => e.id));
    }
    if (name) this.decks[name] = deck;
    return chosen;
  }

  /** A line of the same mood not played in this flight, preferring the least recently seen. */
  private borrow(pool: Pool): string | null {
    const spill = SPILL.get(pool);
    if (!spill) return null;
    const ids = [...new Set(entriesOf(spill).map((e) => e.id))].filter((id) => !this.flightPlayed.has(id));
    return ids.length ? this.leastRecent(ids) : null;
  }

  /** Random among the least recently seen half of `ids`. */
  private leastRecent(ids: string[]): string {
    const sorted = shuffle([...ids]).sort((a, b) => (this.seen[a] ?? -1) - (this.seen[b] ?? -1));
    return sorted[Math.floor(Math.random() * Math.max(1, Math.ceil(sorted.length / 2)))];
  }

  private lastPlayed(): string | undefined {
    let best: string | undefined;
    for (const [id, at] of Object.entries(this.seen)) if (best === undefined || at > this.seen[best]) best = id;
    return best;
  }

  /** Keeps a line going every couple of seconds while the rocket flies. */
  private keepRhythm(multiplier: number, cashedAt: number | null) {
    const now = Date.now();
    if (this.current || this.pending || now - this.flightStartedAt < 800 || now - this.lastEndedAt < this.nextGap) return;
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

  /** Plays after whatever is on now and what's already queued (or right away if idle). Never expires. */
  private enqueue(id: string, priority: Priority, mode: Mode = "normal") {
    if (!id || !clipById(id)) return;
    if (!this.current) return this.start({ id, priority, mode });
    this.queue.push({ id, priority, mode });
    // Reserved for this flight, so nothing else draws it before its turn.
    this.flightPlayed.add(id);
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
    this.flightPlayed.add(req.id);
    this.seen[req.id] = ++this.plays;
    this.saveMemory();
    this.player.play(clip, req.mode).then(() => {
      if (this.current?.token !== token) return; // interrupted
      this.current = null;
      this.lastEndedAt = Date.now();
      const next = this.pending;
      this.pending = null;
      if (next && (next.at === undefined || Date.now() - next.at < PENDING_TTL_MS)) return this.start(next);
      const queued = this.queue.shift();
      if (queued) this.start(queued);
    });
  }
}
