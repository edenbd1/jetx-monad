"use client";

import { useEffect, useRef, type RefObject } from "react";
import { msToReach, multiplierAt } from "@/lib/game-types";

export type Scene = {
  phase: "idle" | "launching" | "flying" | "crashed";
  /** Local ms at which the curve starts. */
  startedAt: number;
  crash: number;
  /** Local ms at which the explosion started. */
  crashedAt: number;
  /** Multiplier the player cashed out at, if they did. */
  cashedAt: number | null;
  /** Wall ms of the last milestone crossed (ring + sparkles), and its tier. */
  milestoneAt?: number;
  milestoneTier?: number;
  /** Wall ms of the player's cash-out (coin burst). */
  cashedWallAt?: number;
  /** Explosion style for this crash: 0 fireball, 1 sparks, 2 nuke. */
  variant?: number;
};

type Star = { x: number; y: number; r: number; depth: number; tw: number };
type Particle = { x: number; y: number; vx: number; vy: number; hue: number; size: number };
type Burst = { at: number; x: number; y: number; parts: Particle[] };

const PAD = { left: 18, right: 42, top: 34, bottom: 30 };
const EXPLOSION_MS = 1_100;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const mix = (c1: [number, number, number], c2: [number, number, number], k: number) =>
  `rgb(${Math.round(lerp(c1[0], c2[0], k))}, ${Math.round(lerp(c1[1], c2[1], k))}, ${Math.round(lerp(c1[2], c2[2], k))})`;

/** Radial burst of particles from a point. */
function burst(x: number, y: number, n: number, speed: [number, number], hue: [number, number], size: [number, number]): Particle[] {
  return Array.from({ length: n }, () => {
    const a = Math.random() * Math.PI * 2;
    const v = speed[0] + Math.random() * (speed[1] - speed[0]);
    return {
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      hue: hue[0] + Math.random() * (hue[1] - hue[0]),
      size: size[0] + Math.random() * (size[1] - size[0]),
    };
  });
}

/** Night sky + the rocket's curve. Reads the shared scene every animation frame. */
export function Sky({ scene }: { scene: RefObject<Scene> }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    // Canvas fonts can't read CSS variables: resolve next/font's family once.
    const family = getComputedStyle(el).fontFamily || "system-ui, sans-serif";
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const stars: Star[] = Array.from({ length: 110 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.3 + 0.3,
      depth: Math.random() * 0.8 + 0.2,
      tw: Math.random() * Math.PI * 2,
    }));
    let particles: Particle[] = [];
    let smoke: Particle[] = [];
    let explodedFor = -1;
    let sparkle: Burst | null = null;
    let coins: Burst | null = null;
    let drift = 0;
    let lastFrame = performance.now();

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      w = el.clientWidth;
      h = el.clientHeight;
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(64, now - lastFrame);
      lastFrame = now;
      const s = scene.current;
      if (!s || w === 0) return;
      const wall = Date.now();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const flying = s.phase === "flying";
      const crashed = s.phase === "crashed";
      const crashMs = msToReach(s.crash);
      const elapsed = flying ? Math.min(wall - s.startedAt, crashMs) : crashed ? crashMs : 0;
      const m = flying || crashed ? Math.min(multiplierAt(elapsed), s.crash) : 1;
      const sinceCrash = crashed ? wall - s.crashedAt : Infinity;

      // --- sky: darkens into deep space as the rocket climbs
      const alt = Math.min(1, Math.log(m) / Math.log(20));
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, mix([7, 10, 36], [2, 2, 12], alt));
      g.addColorStop(0.55, mix([18, 19, 74], [26, 11, 58], alt));
      g.addColorStop(1, mix([42, 23, 99], [62, 13, 74], alt));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      if (alt > 0.15) {
        const neb = ctx.createRadialGradient(w * 0.25, h * 0.3, 10, w * 0.25, h * 0.3, w * 0.9);
        neb.addColorStop(0, `rgba(160, 60, 255, ${0.22 * alt})`);
        neb.addColorStop(0.5, `rgba(60, 120, 255, ${0.1 * alt})`);
        neb.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = neb;
        ctx.fillRect(0, 0, w, h);
      }
      if (alt > 0.35) {
        // a planet rises from the bottom-right past ~3x
        const rise = Math.min(1, (alt - 0.35) / 0.55);
        const pr = w * 0.42;
        const px = w * 0.92;
        const py = h + pr * 0.55 - rise * pr * 0.9;
        const glow = ctx.createRadialGradient(px, py, pr * 0.9, px, py, pr * 1.35);
        glow.addColorStop(0, "rgba(120, 180, 255, 0.25)");
        glow.addColorStop(1, "rgba(120, 180, 255, 0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(px, py, pr * 1.35, 0, Math.PI * 2);
        ctx.fill();
        const body = ctx.createLinearGradient(px - pr, py - pr, px + pr, py + pr);
        body.addColorStop(0, "#5d7bff");
        body.addColorStop(0.5, "#3a2a9e");
        body.addColorStop(1, "#150b3d");
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 200, 255, 0.25)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(px, py, pr * 1.45, pr * 0.28, -0.35, Math.PI * 1.05, Math.PI * 1.95);
        ctx.stroke();
      }
      if (crashed) {
        const heat = Math.max(0.28, 0.75 - sinceCrash / 1600);
        const rg = ctx.createRadialGradient(w * 0.7, h * 0.35, 10, w * 0.6, h * 0.5, Math.max(w, h));
        rg.addColorStop(0, `rgba(255, 45, 110, ${heat})`);
        rg.addColorStop(1, `rgba(120, 10, 60, ${heat * 0.8})`);
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, w, h);
      }

      // --- stars (parallax: faster as the rocket accelerates)
      const speed = flying ? 0.02 + Math.log(m) * 0.05 : 0.004;
      drift += (speed * dt) / 1000;
      const warp = flying ? Math.max(0, Math.min(1, (m - 2.5) / 12)) : 0;
      for (const st of stars) {
        const x = (((st.x - drift * st.depth) % 1) + 1) % 1;
        const y = (((st.y + drift * st.depth * 0.35) % 1) + 1) % 1;
        const a = 0.35 + 0.45 * Math.abs(Math.sin(st.tw + now / 900));
        if (warp > 0) {
          // hyperspace streaks, longer as the rocket speeds up
          const len = (6 + 60 * warp) * st.depth;
          ctx.strokeStyle = `rgba(210, 220, 255, ${Math.min(1, a * st.depth + warp * 0.3)})`;
          ctx.lineWidth = st.r;
          ctx.beginPath();
          ctx.moveTo(x * w, y * h);
          ctx.lineTo(x * w + len, y * h - len * 0.35);
          ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(210, 220, 255, ${a * st.depth})`;
          ctx.beginPath();
          ctx.arc(x * w, y * h, st.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // --- camera: zooms out as the flight goes on
      const tMax = Math.max(9_000, elapsed * 1.18);
      const mMax = Math.max(2, 1 + (m - 1) * 1.3);
      const plotW = w - PAD.left - PAD.right;
      const plotH = h - PAD.top - PAD.bottom;
      const X = (t: number) => PAD.left + (t / tMax) * plotW;
      const Y = (mm: number) => h - PAD.bottom - ((mm - 1) / (mMax - 1)) * plotH;

      // grid + multiplier ticks
      ctx.lineWidth = 1;
      ctx.font = `600 10px ${family}`;
      ctx.textAlign = "right";
      const step = niceStep((mMax - 1) / 4);
      for (let v = 1; v <= mMax + 1e-9; v += step) {
        const y = Y(v);
        ctx.strokeStyle = "rgba(140, 150, 255, 0.08)";
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(w - PAD.right + 30, y);
        ctx.stroke();
        ctx.fillStyle = "rgba(170, 180, 255, 0.45)";
        ctx.fillText(`${v.toFixed(v < 10 ? 1 : 0)}x`, w - 6, y - 3);
      }
      const tStep = niceStep(tMax / 5000) * 1000;
      ctx.textAlign = "center";
      for (let t = 0; t <= tMax; t += tStep) {
        const x = X(t);
        ctx.strokeStyle = "rgba(140, 150, 255, 0.06)";
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, h - PAD.bottom);
        ctx.stroke();
        ctx.fillStyle = "rgba(170, 180, 255, 0.35)";
        ctx.fillText(`${Math.round(t / 1000)}s`, x, h - 10);
      }

      // --- curve
      let tipX = X(0);
      let tipY = Y(1);
      let angle = -0.35;
      if (elapsed > 0) {
        const n = 80;
        ctx.beginPath();
        ctx.moveTo(X(0), Y(1));
        for (let i = 1; i <= n; i++) {
          const t = (elapsed * i) / n;
          ctx.lineTo(X(t), Y(multiplierAt(t)));
        }
        tipX = X(elapsed);
        tipY = Y(m);
        const prevT = Math.max(0, elapsed - 250);
        angle = Math.atan2(tipY - Y(multiplierAt(prevT)), tipX - X(prevT));
        // area under the curve
        ctx.save();
        ctx.lineTo(tipX, h - PAD.bottom);
        ctx.lineTo(X(0), h - PAD.bottom);
        ctx.closePath();
        const fill = ctx.createLinearGradient(0, tipY, 0, h - PAD.bottom);
        fill.addColorStop(0, crashed ? "rgba(255, 70, 120, 0.28)" : "rgba(255, 64, 129, 0.30)");
        fill.addColorStop(1, "rgba(255, 64, 129, 0)");
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.restore();
        // glowing trail
        ctx.beginPath();
        ctx.moveTo(X(0), Y(1));
        for (let i = 1; i <= n; i++) {
          const t = (elapsed * i) / n;
          ctx.lineTo(X(t), Y(multiplierAt(t)));
        }
        const stroke = ctx.createLinearGradient(X(0), 0, tipX, 0);
        stroke.addColorStop(0, "rgba(255, 90, 140, 0.15)");
        stroke.addColorStop(1, crashed ? "#ff5d8f" : "#ffb347");
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 3.5;
        ctx.lineCap = "round";
        ctx.shadowColor = crashed ? "#ff2d6f" : "#ff8a3d";
        ctx.shadowBlur = 16;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // --- cash-out marker
      if (s.cashedAt && elapsed > 0) {
        const tc = msToReach(s.cashedAt);
        if (tc <= elapsed + 1) {
          const cx = X(tc);
          const cy = Y(s.cashedAt);
          ctx.fillStyle = "#2cf58f";
          ctx.shadowColor = "#2cf58f";
          ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.arc(cx, cy, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.font = `800 11px ${family}`;
          ctx.textAlign = "left";
          ctx.fillText(`✓ ${s.cashedAt.toFixed(2)}x`, cx + 8, cy - 8);
        }
      }

      // --- milestone: ring + golden sparkles around the rocket
      if (s.milestoneAt && wall - s.milestoneAt < 900) {
        if (!sparkle || sparkle.at !== s.milestoneAt) {
          const n = 18 + (s.milestoneTier ?? 1) * 10;
          sparkle = { at: s.milestoneAt, x: tipX, y: tipY, parts: burst(tipX, tipY, n, [60, 200], [38, 60], [1.2, 3]) };
        }
        const k = (wall - sparkle.at) / 900;
        ctx.strokeStyle = `rgba(255, 216, 107, ${0.8 * (1 - k)})`;
        ctx.lineWidth = 3 * (1 - k) + 0.5;
        ctx.beginPath();
        ctx.arc(sparkle.x, sparkle.y, 12 + 90 * k, 0, Math.PI * 2);
        ctx.stroke();
        const tS = (wall - sparkle.at) / 1000;
        for (const p of sparkle.parts) {
          ctx.fillStyle = `hsla(${p.hue}, 100%, 65%, ${1 - k})`;
          ctx.beginPath();
          ctx.arc(p.x + p.vx * tS, p.y + p.vy * tS, p.size * (1 - k * 0.5), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // --- cash-out: coins burst from the marker
      if (s.cashedWallAt && s.cashedAt && wall - s.cashedWallAt < 1_400) {
        if (!coins || coins.at !== s.cashedWallAt) {
          const cx = X(Math.min(msToReach(s.cashedAt), elapsed));
          const cy = Y(s.cashedAt);
          coins = { at: s.cashedWallAt, x: cx, y: cy, parts: burst(cx, cy, 28, [90, 260], [45, 150], [3, 5.5]) };
        }
        const k = (wall - coins.at) / 1_400;
        const tS = (wall - coins.at) / 1000;
        for (const p of coins.parts) {
          const x = p.x + p.vx * tS;
          const y = p.y + p.vy * tS - 40 * tS + 260 * tS * tS;
          ctx.fillStyle = p.hue > 100 ? `rgba(44, 245, 143, ${1 - k})` : `rgba(255, 210, 80, ${1 - k})`;
          ctx.beginPath();
          ctx.ellipse(x, y, p.size, p.size * Math.abs(Math.cos(tS * 9 + p.hue)), 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // --- rocket / explosion
      if (crashed) {
        const variant = s.variant ?? 0;
        if (explodedFor !== s.crashedAt) {
          explodedFor = s.crashedAt;
          particles =
            variant === 1
              ? burst(tipX, tipY, 90, [120, 420], [20, 55], [0.8, 2.2])
              : burst(tipX, tipY, variant === 2 ? 70 : 60, [40, 260], [5, 45], [1.5, 4.5]);
          smoke = burst(tipX, tipY, variant === 2 ? 16 : 10, [10, 50], [0, 0], [10, 22]);
        }
        const tS = sinceCrash / 1000;
        // nuke: the whole sky flashes white first
        if (variant === 2 && sinceCrash < 260) {
          ctx.fillStyle = `rgba(255, 250, 235, ${0.85 * (1 - sinceCrash / 260)})`;
          ctx.fillRect(0, 0, w, h);
        }
        // fireball core
        if (sinceCrash < EXPLOSION_MS) {
          const k = sinceCrash / EXPLOSION_MS;
          const r = (variant === 2 ? 30 : 16) + (variant === 2 ? 150 : 95) * k;
          const core = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, r);
          core.addColorStop(0, `rgba(255, 255, 230, ${0.9 * (1 - k)})`);
          core.addColorStop(0.35, `rgba(255, 170, 60, ${0.75 * (1 - k)})`);
          core.addColorStop(1, "rgba(255, 40, 90, 0)");
          ctx.fillStyle = core;
          ctx.beginPath();
          ctx.arc(tipX, tipY, r, 0, Math.PI * 2);
          ctx.fill();
          // shockwave ring
          ctx.strokeStyle = `rgba(255, 230, 200, ${0.7 * (1 - k)})`;
          ctx.lineWidth = 4 * (1 - k) + 1;
          ctx.beginPath();
          ctx.arc(tipX, tipY, 20 + (variant === 2 ? 320 : 220) * k, 0, Math.PI * 2);
          ctx.stroke();
        }
        // smoke puffs drifting up
        const smokeLife = 1 - sinceCrash / 2_200;
        if (smokeLife > 0) {
          for (const p of smoke) {
            const x = p.x + p.vx * tS;
            const y = p.y + p.vy * tS - (variant === 2 ? 55 : 25) * tS;
            ctx.fillStyle = `rgba(90, 70, 110, ${0.35 * smokeLife})`;
            ctx.beginPath();
            ctx.arc(x, y, p.size * (1 + tS * 1.6), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        // Wall-clock physics so throttled frames don't stretch the explosion.
        const life = 1 - sinceCrash / (variant === 1 ? 700 : 1_000);
        if (life > 0) {
          for (const p of particles) {
            const x = p.x + p.vx * tS;
            const y = p.y + p.vy * tS + 90 * tS * tS;
            if (variant === 1) {
              ctx.strokeStyle = `hsla(${p.hue}, 100%, 65%, ${life})`;
              ctx.lineWidth = p.size;
              ctx.beginPath();
              ctx.moveTo(x, y);
              ctx.lineTo(x - p.vx * 0.05, y - p.vy * 0.05);
              ctx.stroke();
            } else {
              ctx.fillStyle = `hsla(${p.hue}, 100%, 60%, ${life})`;
              ctx.beginPath();
              ctx.arc(x, y, p.size, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      } else {
        const shake = s.phase === "launching" ? Math.sin(now / 22) * 1.6 : 0;
        const bob = s.phase === "idle" ? Math.sin(now / 420) * 3 : 0;
        drawRocket(ctx, tipX + 10 + shake, tipY - 6 + bob, flying ? angle : -0.35, now, flying || s.phase === "launching");
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [scene]);

  return <canvas ref={canvas} className="sky-canvas" />;
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** A small jet with an afterburner, pointing along `angle`. */
function drawRocket(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, now: number, burning: boolean) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  // flame
  if (burning) {
    const len = 18 + Math.sin(now / 35) * 5 + Math.random() * 4;
    const fg = ctx.createLinearGradient(-14, 0, -14 - len, 0);
    fg.addColorStop(0, "rgba(255, 245, 200, 0.95)");
    fg.addColorStop(0.35, "rgba(255, 150, 40, 0.9)");
    fg.addColorStop(1, "rgba(255, 40, 90, 0)");
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-13, -4);
    ctx.quadraticCurveTo(-14 - len, 0, -13, 4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.shadowColor = "rgba(255, 120, 60, 0.8)";
  ctx.shadowBlur = burning ? 14 : 6;
  // wings
  ctx.fillStyle = "#c7cff5";
  ctx.beginPath();
  ctx.moveTo(-2, -2);
  ctx.lineTo(-9, -13);
  ctx.lineTo(-4, -13);
  ctx.lineTo(6, -2);
  ctx.closePath();
  ctx.moveTo(-2, 2);
  ctx.lineTo(-9, 13);
  ctx.lineTo(-4, 13);
  ctx.lineTo(6, 2);
  ctx.closePath();
  ctx.fill();
  // tail fin
  ctx.beginPath();
  ctx.moveTo(-12, -1);
  ctx.lineTo(-16, -8);
  ctx.lineTo(-12, -8);
  ctx.lineTo(-7, -1);
  ctx.closePath();
  ctx.fill();
  // fuselage
  const body = ctx.createLinearGradient(0, -5, 0, 5);
  body.addColorStop(0, "#ffffff");
  body.addColorStop(1, "#8f9ad6");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(18, 0);
  ctx.quadraticCurveTo(12, -5, 0, -4.5);
  ctx.lineTo(-13, -3.5);
  ctx.lineTo(-13, 3.5);
  ctx.lineTo(0, 4.5);
  ctx.quadraticCurveTo(12, 5, 18, 0);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  // cockpit + stripe
  ctx.fillStyle = "#3dd6ff";
  ctx.beginPath();
  ctx.ellipse(9, -1.2, 3.6, 1.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ff3d7f";
  ctx.fillRect(-10, -0.8, 12, 1.6);
  ctx.restore();
}
