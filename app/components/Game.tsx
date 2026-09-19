"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KaarisCam, type KaarisCamHandle } from "@/components/KaarisCam";
import { Sky, type Scene } from "@/components/Sky";
import { getChain } from "@/lib/get-chain";
import { msToReach, multiplierAt, toX100, type Address, type Balances, type Flight, type GameChain, type TxInfo } from "@/lib/game-types";
import { KaarisDirector, RULES } from "@/lib/kaaris";
import { mult, short, tier, usd } from "@/lib/format";
import { BIG_CRASH_WORDS, CRASH_WORDS, MILESTONES, WIN_WORDS, pick, sfx, tierOf } from "@/lib/fx";

type Round = "idle" | "launching" | "flying" | "crashed";
type TxRow = {
  key: number;
  step: 1 | 2;
  label: string;
  status: "pending" | "ok" | "error";
  tx?: TxInfo;
  error?: string;
};
type Result = { win: boolean; amount: number; multiplier: number };
type Fx = { key: number; kind: "crash" | "win" | "launch" | "milestone"; text: string; tier?: number };
type Flash = { key: number; color: "red" | "green" | "white" };

const MIN_BET = 0.1;
const CHIPS = [1, 10, 50, 100, 500];
const MUTE_KEY = "fusee-muted";
const NEXT_ROUND_MS = 1_300;

/** No house maximum: a bet is only limited by what the wallet holds. */
const clampBet = (n: number, max = Infinity) => Math.max(MIN_BET, Math.min(max, Math.round(n * 100) / 100));
/** Wall clock for the flight loop and handlers (kept out of render). */
const nowMs = () => Date.now();
const vibrate = (p: number | number[]) => {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(p);
};
const message = (e: unknown) => {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? "Something went wrong";
  return m.length > 120 ? `${m.slice(0, 120)}…` : m;
};

export function Game() {
  const [stage, setStage] = useState<"splash" | "loading" | "play">("splash");
  const [address, setAddress] = useState<Address | null>(null);
  const [bal, setBal] = useState<Balances | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [betInput, setBetInput] = useState("10");
  const [autoOn, setAutoOn] = useState(false);
  const [autoInput, setAutoInput] = useState("2.00");
  const [round, setRound] = useState<Round>("idle");
  const [cashed, setCashed] = useState<{ multiplier: number; payout: number } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [txs, setTxs] = useState<TxRow[]>([]);
  const [pending, setPending] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [nudge, setNudge] = useState(0);
  const [crashedView, setCrashedView] = useState(false);
  const [camMode, setCamMode] = useState<string | null>(null);
  const [muted, setMuted] = useState(() => typeof window !== "undefined" && localStorage.getItem(MUTE_KEY) === "1");
  const [fx, setFx] = useState<Fx | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [shake, setShake] = useState<"soft" | "hard" | null>(null);
  const fxKey = useRef(0);

  const scene = useRef<Scene>({ phase: "idle", startedAt: 0, crash: 1, crashedAt: 0, cashedAt: null });
  const cam = useRef<KaarisCamHandle>(null);
  const multText = useRef<HTMLDivElement>(null);
  const cashText = useRef<HTMLSpanElement>(null);
  const live = useRef({
    flight: null as Flight | null,
    cashedAt: null as number | null,
    round: "idle" as Round,
    auto: null as number | null,
    /** Index of the next milestone to celebrate this flight. */
    milestone: 0,
  });
  const txKey = useRef(0);
  const directorRef = useRef<KaarisDirector | null>(null);

  const director = useCallback(() => {
    if (!directorRef.current) {
      directorRef.current = new KaarisDirector({
        play: (clip, mode) => cam.current?.play(clip, mode) ?? Promise.resolve(),
        stop: () => cam.current?.stop(),
      });
    }
    return directorRef.current;
  }, []);

  const bet = clampBet(Number(betInput) || 0);
  const maxBet = bal ? Math.floor(bal.usdc * 100) / 100 : Infinity;
  const auto = Math.max(1.01, Number(autoInput) || 0);
  const broke = !!bal && bal.usdc < MIN_BET;
  const busy = round === "launching" || round === "flying" || pending > 0;

  // ---------------------------------------------------------------- helpers

  const refresh = useCallback(() => {
    getChain()
      .balances()
      .then(setBal)
      .catch(() => undefined);
  }, []);

  const showError = useCallback((e: unknown) => {
    setToast(message(e));
  }, []);

  /** Slams a word across the sky, optionally with a screen flash and shake. */
  const punch = useCallback((f: Omit<Fx, "key">, flashColor?: Flash["color"], shakeKind?: "soft" | "hard") => {
    const key = ++fxKey.current;
    setFx({ ...f, key });
    if (flashColor) setFlash({ key, color: flashColor });
    if (shakeKind) {
      setShake(null);
      requestAnimationFrame(() => setShake(shakeKind));
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4_500);
    return () => clearTimeout(t);
  }, [toast]);

  function addTx(step: 1 | 2, label: string) {
    const key = ++txKey.current;
    setTxs((rows) => [{ key, step, label, status: "pending" as const }, ...rows].slice(0, 4));
    setPending((p) => p + 1);
    return key;
  }

  function endTx(key: number, patch: Partial<TxRow>) {
    setTxs((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setPending((p) => Math.max(0, p - 1));
  }

  // ---------------------------------------------------------------- flow

  // The managed wallet is created and sponsored (gas + 1,000 test USDC) as soon as the page loads,
  // so the dollars are already there when the player taps in. No login, no wallet, no signature.
  const readying = useRef<ReturnType<GameChain["ready"]> | null>(null);
  const prepare = useCallback(() => {
    readying.current ??= getChain().ready();
    return readying.current;
  }, []);
  useEffect(() => {
    prepare().catch(() => undefined);
  }, [prepare]);

  function enter() {
    // Runs inside the tap: this unlocks audio on the facecam's <video> and the sound effects.
    sfx.muted = muted;
    sfx.unlock();
    director().landing();
    setStage("loading");
    prepare()
      .then(({ address, balances }) => {
        setAddress(address);
        setBal(balances);
      })
      .catch((e) => {
        readying.current = null; // let the next tap retry
        showError(e);
      })
      .finally(() => setStage("play"));
    getChain()
      .history()
      .then(setHistory)
      .catch(() => undefined);
  }

  async function launch() {
    if (busy || !bal) return;
    if (bet > bal.usdc) return showError(new Error(`Not enough USDC for a ${usd(bet)} bet`));
    setResult(null);
    setCashed(null);
    setCrashedView(false);
    live.current = { flight: null, cashedAt: null, round: "launching", auto: autoOn ? auto : null, milestone: 0 };
    scene.current = { ...scene.current, phase: "launching", cashedAt: null };
    setRound("launching");
    director().bet();
    const key = addTx(1, "launch");
    try {
      const f = await getChain().launch(bet);
      endTx(key, { status: "ok", tx: f.tx });
      setBal((b) => (b ? { ...b, usdc: b.usdc - bet } : b));
      live.current.flight = f;
      live.current.round = "flying";
      scene.current = { phase: "flying", startedAt: f.startedAt, crash: f.crash, crashedAt: 0, cashedAt: null };
      setRound("flying");
      director().launched();
      punch({ kind: "launch", text: "🚀 DÉCOLLAGE !" }, undefined, "soft");
      sfx.launch();
    } catch (e) {
      endTx(key, { status: "error", error: message(e) });
      live.current.round = "idle";
      scene.current = { ...scene.current, phase: "idle" };
      setRound("idle");
      showError(e);
      refresh();
    }
  }

  const cashOut = useCallback(
    (target?: number) => {
      const f = live.current.flight;
      if (!f || live.current.round !== "flying" || live.current.cashedAt !== null) return;
      const elapsed = nowMs() - f.startedAt;
      if (target === undefined && elapsed >= msToReach(f.crash)) return; // too late, it's gone
      const x = toX100(Math.min(target ?? multiplierAt(elapsed), f.crash)) / 100;
      if (x < 1) return;
      const payout = (f.bet * Math.round(x * 100)) / 100;
      live.current.cashedAt = x;
      scene.current.cashedAt = x;
      scene.current.cashedWallAt = nowMs();
      setCashed({ multiplier: x, payout });
      director().cashedOut(x);
      punch({ kind: "win", text: `${pick(WIN_WORDS)} +${usd(payout)}` }, "green");
      sfx.cashout();
      vibrate(35);
      const key = ++txKey.current;
      setTxs((rows) => [{ key, step: 2 as const, label: "cash out", status: "pending" as const }, ...rows].slice(0, 4));
      setPending((p) => p + 1);
      getChain()
        .cashOut(f, x)
        .then(({ tx }) => {
          setTxs((rows) => rows.map((r) => (r.key === key ? { ...r, status: "ok", tx } : r)));
          refresh();
        })
        .catch((e) => {
          setTxs((rows) => rows.map((r) => (r.key === key ? { ...r, status: "error", error: message(e) } : r)));
          setToast(message(e));
        })
        .finally(() => setPending((p) => Math.max(0, p - 1)));
    },
    [director, refresh, punch],
  );

  const crash = useCallback(
    (f: Flight) => {
      const cashedAt = live.current.cashedAt;
      live.current.round = "crashed";
      const big = f.crash >= 5;
      // Three explosion styles; the big ones always go nuclear.
      const variant = big ? 2 : Math.floor(Math.random() * 2);
      scene.current = { ...scene.current, phase: "crashed", crashedAt: nowMs(), variant };
      punch({ kind: "crash", text: pick(big ? BIG_CRASH_WORDS : CRASH_WORDS) }, big ? "white" : "red", "hard");
      sfx.boom(big);
      if (multText.current) multText.current.textContent = mult(f.crash);
      setCrashedView(true);
      setRound("crashed");
      setHistory((h) => [f.crash, ...h].slice(0, 20));
      director().crashed(f.crash, cashedAt === null);
      if (cashedAt === null) {
        vibrate([70, 40, 140]);
        setResult({ win: false, amount: f.bet, multiplier: f.crash });
        const key = ++txKey.current;
        setTxs((rows) => [{ key, step: 2 as const, label: "settle", status: "pending" as const }, ...rows].slice(0, 4));
        setPending((p) => p + 1);
        getChain()
          .settle(f)
          .then(({ tx }) => {
            setTxs((rows) => rows.map((r) => (r.key === key ? { ...r, status: "ok", tx } : r)));
            refresh();
          })
          .catch((e) => setTxs((rows) => rows.map((r) => (r.key === key ? { ...r, status: "error", error: message(e) } : r))))
          .finally(() => setPending((p) => Math.max(0, p - 1)));
      } else {
        setResult({ win: true, amount: (f.bet * Math.round(cashedAt * 100)) / 100 - f.bet, multiplier: cashedAt });
      }
      setTimeout(() => {
        if (live.current.round !== "crashed") return;
        live.current.round = "idle";
        setRound("idle");
      }, NEXT_ROUND_MS);
    },
    [director, refresh, punch],
  );

  // Flight loop: multiplier text, live cash-out amount, auto cash-out, Kaaris thresholds.
  useEffect(() => {
    if (round !== "flying") return;
    let raf = 0;
    const tick = () => {
      const f = live.current.flight;
      if (!f) return;
      const elapsed = nowMs() - f.startedAt;
      const autoAt = live.current.auto;
      if (elapsed >= msToReach(f.crash)) {
        if (autoAt !== null && live.current.cashedAt === null && autoAt <= f.crash) cashOut(autoAt);
        crash(f);
        return;
      }
      const m = multiplierAt(elapsed);
      if (multText.current) {
        multText.current.textContent = mult(m);
        const t = String(tierOf(m));
        if (multText.current.dataset.tier !== t) multText.current.dataset.tier = t;
      }
      const next = MILESTONES[live.current.milestone];
      if (next && m >= next.at) {
        live.current.milestone += 1;
        scene.current.milestoneAt = nowMs();
        scene.current.milestoneTier = next.tier;
        punch({ kind: "milestone", text: next.label, tier: next.tier });
        sfx.milestone(next.tier);
        const el = multText.current;
        if (el) {
          el.classList.remove("pop");
          void el.offsetWidth; // restart the animation
          el.classList.add("pop");
        }
      }
      if (live.current.cashedAt === null) {
        if (cashText.current) cashText.current.textContent = usd(f.bet * m);
        if (autoAt !== null && m >= autoAt) cashOut(autoAt);
      }
      director().tick(m, live.current.cashedAt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [round, cashOut, crash, director, punch]);

  // Idle chatter after 20 s on the bet screen.
  useEffect(() => {
    if (stage !== "play" || round !== "idle" || broke) return;
    const t = setTimeout(() => director().idle(), RULES.idleMs);
    return () => clearTimeout(t);
  }, [stage, round, broke, nudge, director]);

  // Out of test dollars.
  useEffect(() => {
    if (stage === "play" && broke && round === "idle") director().broke();
  }, [stage, broke, round, director]);

  async function refill() {
    const key = addTx(2, "refill");
    try {
      const b = await getChain().refill();
      setBal(b);
      endTx(key, { status: "ok" });
    } catch (e) {
      endTx(key, { status: "error", error: message(e) });
      showError(e);
    }
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    sfx.muted = next;
    cam.current?.setMuted(next);
    localStorage.setItem(MUTE_KEY, next ? "1" : "0");
  }

  // ---------------------------------------------------------------- render

  const chain = stage === "splash" ? null : getChain();
  const flying = round === "flying";

  let cta: React.ReactNode;
  if (broke && round === "idle") {
    cta = (
      <button key="refill" className="cta cta-refill" onClick={refill} disabled={pending > 0}>
        <b>REFILL</b>
        <small>+1,000 test USDC</small>
      </button>
    );
  } else if (round === "launching") {
    cta = (
      <button key="launching" className="cta cta-wait" disabled>
        <b>
          <i className="spin" /> LAUNCHING…
        </b>
        <small>TX 1 on Monad</small>
      </button>
    );
  } else if (flying && !cashed) {
    cta = (
      <button key="cash" className="cta cta-cash" onClick={() => cashOut()}>
        <b>CASH OUT</b>
        <span ref={cashText} className="num" />
      </button>
    );
  } else if (flying && cashed) {
    cta = (
      <button key="cashed" className="cta cta-cashed" disabled>
        <b>CASHED OUT</b>
        <span className="num">
          +{usd(cashed.payout)} @ {mult(cashed.multiplier)}
        </span>
      </button>
    );
  } else if (round === "crashed" || pending > 0) {
    cta = (
      <button key="wait" className="cta cta-wait" disabled>
        <b>{pending > 0 ? "CONFIRMING…" : "NEXT ROUND…"}</b>
        <small>{pending > 0 ? "TX 2 on Monad" : " "}</small>
      </button>
    );
  } else {
    cta = (
      <button key="bet" className="cta cta-bet" onClick={launch} disabled={!bal}>
        <b>BET</b>
        <span className="num">{usd(bet)}</span>
      </button>
    );
  }

  return (
    <div className="stage" onPointerDown={() => setNudge((n) => n + 1)}>
      <div
        className={`phone ${shake ? `shake-${shake}` : ""}`}
        data-cam={camMode ?? undefined}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setShake(null);
        }}
      >
        {flash && <div key={flash.key} className={`fx-flash fx-flash-${flash.color}`} onAnimationEnd={() => setFlash(null)} />}
        {stage === "splash" && (
          <button className="splash" onClick={enter}>
            <div className="splash-bg" />
            <div className="splash-body">
              <div className="brand brand-xl">
                FUSÉE<span>JETX · MONAD</span>
              </div>
              <p className="splash-sub">Le jeu de la fusée. Chaque vol = 2 transactions sur Monad.</p>
              <div className="splash-tap">Appuie pour jouer</div>
            </div>
          </button>
        )}

        {stage !== "splash" && (
          <>
            <header className="topbar">
              <div className="brand">
                FUSÉE<span>MONAD</span>
              </div>
              <div className="topbar-right">
                <button className="mute" onClick={toggleMute} aria-label={muted ? "Unmute Kaaris" : "Mute Kaaris"}>
                  {muted ? "🔇" : "🔊"}
                </button>
                <a
                  className="wallet"
                  href={address && chain ? chain.explorerAddress(address) : undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="wallet-usd num">{bal ? usd(bal.usdc) : "—"}</span>
                  <span className="wallet-meta">
                    <i className="gas" /> {bal ? `${bal.mon.toFixed(3)} MON` : "…"} · {address ? short(address) : "wallet…"}
                  </span>
                </a>
              </div>
            </header>

            <div className="history" aria-label="Previous flights">
              {history.length === 0 && <span className="history-empty">No flights yet</span>}
              {history.map((m, i) => (
                <span key={`${history.length - i}`} className={`pill pill-${tier(m)}`}>
                  {mult(m)}
                </span>
              ))}
            </div>

            <section className="sky" data-phase={crashedView ? "crashed" : round}>
              <Sky scene={scene} />
              {fx && (
                <div
                  key={fx.key}
                  className={`fx-slam fx-${fx.kind} fx-tier-${fx.tier ?? 0}`}
                  onAnimationEnd={() => setFx((cur) => (cur?.key === fx.key ? null : cur))}
                >
                  {fx.text}
                </div>
              )}
              <div className="sky-center">
                {stage === "loading" && <div className="sky-status">Préparation du wallet…</div>}
                {stage === "play" && round === "idle" && !crashedView && (
                  <div className="sky-status">
                    <b>Place ta mise</b>
                    <span>Le jet décolle dès que ta TX est confirmée</span>
                  </div>
                )}
                {round === "launching" && <div className="sky-status">Décollage…</div>}
                {(flying || crashedView) && (
                  <>
                    {crashedView && <div className="flew">FLEW AWAY!</div>}
                    {/* Text is written every frame by the flight loop, outside React. */}
                    <div ref={multText} className={`multiplier num ${crashedView ? "is-crashed" : ""}`} />
                  </>
                )}
                {cashed && (
                  <div className="win-chip num">
                    +{usd(cashed.payout)} <small>@ {mult(cashed.multiplier)}</small>
                  </div>
                )}
                {crashedView && result && !result.win && (
                  <div className="loss-chip num">−{usd(result.amount)}</div>
                )}
              </div>
            </section>

            <div className="txfeed">
              {txs.length === 0 && <div className="tx-empty">Chaque vol : TX 1 au décollage · TX 2 à l’atterrissage (ou au crash)</div>}
              {txs.slice(0, 2).map((t) => (
                <div key={t.key} className={`tx tx-${t.status}`}>
                  <span className="tx-step">TX {t.step}</span>
                  <span className="tx-label">{t.label}</span>
                  {t.status === "pending" && (
                    <span className="tx-meta">
                      <i className="spin" /> signing…
                    </span>
                  )}
                  {t.status === "ok" && t.tx && chain && (
                    <a className="tx-meta" href={chain.explorerTx(t.tx.hash)} target="_blank" rel="noreferrer">
                      ✓ {t.tx.confirmMs} ms · #{t.tx.block.toLocaleString("en-US")} ↗
                    </a>
                  )}
                  {t.status === "ok" && !t.tx && <span className="tx-meta">✓ done</span>}
                  {t.status === "error" && <span className="tx-meta">✕ {t.error}</span>}
                </div>
              ))}
            </div>

            <section className="panel">
              <div className="panel-row">
                <div className="stepper">
                  <button onClick={() => setBetInput(String(clampBet(bet >= 2 ? bet - 1 : bet / 2)))} disabled={busy}>
                    −
                  </button>
                  <label>
                    <small>Mise (USDC)</small>
                    <input
                      className="num"
                      value={betInput}
                      inputMode="decimal"
                      disabled={busy}
                      onChange={(e) => setBetInput(e.target.value.replace(/[^\d.]/g, ""))}
                      onBlur={() => setBetInput(String(clampBet(bet, maxBet)))}
                      aria-label="Bet amount in USDC"
                    />
                  </label>
                  <button onClick={() => setBetInput(String(clampBet(bet >= 1 ? bet + 1 : bet * 2, maxBet)))} disabled={busy}>
                    +
                  </button>
                </div>
                <div className={`auto ${autoOn ? "is-on" : ""}`}>
                  <button className="switch" onClick={() => setAutoOn((v) => !v)} disabled={busy} aria-pressed={autoOn}>
                    <i />
                  </button>
                  <label>
                    <small>Auto cash-out</small>
                    <span>
                      <input
                        className="num"
                        value={autoInput}
                        inputMode="decimal"
                        disabled={busy || !autoOn}
                        onChange={(e) => setAutoInput(e.target.value.replace(/[^\d.]/g, ""))}
                        onBlur={() => setAutoInput(auto.toFixed(2))}
                        aria-label="Auto cash-out multiplier"
                      />
                      x
                    </span>
                  </label>
                </div>
              </div>
              <div className="chips">
                {CHIPS.map((c) => (
                  <button key={c} className={bet === c ? "is-on" : ""} onClick={() => setBetInput(String(c))} disabled={busy || c > maxBet}>
                    {c}
                  </button>
                ))}
                <button className={bet === maxBet ? "is-on" : ""} onClick={() => setBetInput(String(clampBet(maxBet)))} disabled={busy || !bal}>
                  MAX
                </button>
              </div>
              {cta}
            </section>
          </>
        )}

        <KaarisCam ref={cam} muted={muted} onMode={setCamMode} />

        {toast && (
          <div className="toast" role="alert" onClick={() => setToast(null)}>
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
