"use client";

import { useEffect, useState } from "react";
import { mult, usd } from "@/lib/format";
import type { Address } from "@/lib/game-types";
import type { Leaderboard as Board, LeaderboardEntry } from "@/lib/leaderboard";
import { pilotName, pilotTag } from "@/lib/names";

const SHOWN = 50;
const MEDALS = ["🥇", "🥈", "🥉"];

/** Full-screen ranking of the pilots with the most USDC, refreshed every few seconds while open. */
export function Leaderboard({ me, onClose }: { me: Address | null; onClose: () => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/leaderboard")
        .then((r) => (r.ok ? (r.json() as Promise<Board>) : Promise.reject(new Error(String(r.status)))))
        .then((b) => {
          if (!live) return;
          setBoard(b);
          setFailed(false);
        })
        .catch(() => live && setFailed(true));
    void load();
    const timer = setInterval(load, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const isMe = (e: LeaderboardEntry) => !!me && e.address.toLowerCase() === me.toLowerCase();
  const myRank = board ? board.entries.findIndex(isMe) : -1;
  const mine = myRank >= 0 ? board?.entries[myRank] : undefined;

  const row = (e: LeaderboardEntry, i: number) => (
    <li key={e.address} className={`lb-row ${isMe(e) ? "is-me" : ""} ${i < 3 ? `lb-podium lb-podium-${i + 1}` : ""}`}>
      <span className="lb-rank num">{i < 3 ? MEDALS[i] : i + 1}</span>
      <span className="lb-name">
        <b>
          {pilotName(e.address)}
          {isMe(e) && <em>TOI</em>}
        </b>
        <small>
          {e.flights} vol{e.flights > 1 ? "s" : ""} · {pilotTag(e.address)}
        </small>
      </span>
      <span className="lb-usd num">{usd(e.usdc)}</span>
    </li>
  );

  return (
    <div className="lb" role="dialog" aria-label="Leaderboard">
      <div className="lb-head">
        <div>
          <b>🏆 CLASSEMENT</b>
          <small>Les pilotes qui ont le plus d&apos;USDC{board ? ` · ${board.players} joueurs` : ""}</small>
        </div>
        <button className="lb-close" onClick={onClose} aria-label="Close leaderboard">
          ✕
        </button>
      </div>

      {board?.best && (
        <div className="lb-record">
          🚀 Record : <b className="num">{mult(board.best.multiplier)}</b> par {pilotName(board.best.by)}
        </div>
      )}
      {mine && (
        <div className="lb-me">
          Toi : <b className="num">#{myRank + 1}</b> · {pilotName(mine.address)} · <b className="num">{usd(mine.usdc)}</b>
        </div>
      )}
      {me && board && !mine && <div className="lb-me">Fais un vol pour entrer au classement 🚀</div>}

      {!board && <div className="lb-empty">{failed ? "Classement indisponible, on réessaie…" : "Chargement…"}</div>}
      {board && board.entries.length === 0 && <div className="lb-empty">Personne n&apos;a encore volé.</div>}
      {board && (
        <ol className="lb-list">
          {board.entries.slice(0, SHOWN).map(row)}
          {mine && myRank >= SHOWN && row(mine, myRank)}
        </ol>
      )}
    </div>
  );
}
