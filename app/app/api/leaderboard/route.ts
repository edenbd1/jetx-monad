import { NextResponse } from "next/server";
import { createPublicClient, fallback, http, type Address } from "viem";
import { erc20Abi, jetxAbi } from "@/lib/abi";
import { CHAIN, DEPLOYMENT, RPC_URLS, USDC_DECIMALS } from "@/lib/config";
import type { Leaderboard } from "@/lib/leaderboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ranking of every player who flew, by USDC balance. Public RPCs cap eth_getLogs at ~100 blocks,
 * so players are found from the game itself: every round stores its player, and rounds are read
 * in multicall batches (only the new ones on each refresh). Balances are one multicall too.
 * The CDN caches the answer a few seconds, so a room full of phones costs a handful of RPC calls.
 */
const CHUNK = 300;
const FRESH_MS = 3_000;
const MAX_ENTRIES = 500;

const client = createPublicClient({
  chain: CHAIN,
  transport: fallback(RPC_URLS.map((url) => http(url, { retryCount: 1, timeout: 8_000 }))),
});

const state = {
  scanned: 0,
  flights: new Map<Address, number>(),
  board: null as Leaderboard | null,
  refreshing: null as Promise<Leaderboard> | null,
};

async function refresh(): Promise<Leaderboard> {
  const game = { address: DEPLOYMENT.game, abi: jetxAbi } as const;
  const [count, best, bestBy] = await client.multicall({
    contracts: [
      { ...game, functionName: "roundCount" },
      { ...game, functionName: "bestCashOut" },
      { ...game, functionName: "bestCashOutBy" },
    ],
    allowFailure: false,
  });

  for (let from = state.scanned + 1; from <= Number(count); from += CHUNK) {
    const to = Math.min(Number(count), from + CHUNK - 1);
    const ids = Array.from({ length: to - from + 1 }, (_, i) => BigInt(from + i));
    const rounds = await client.multicall({
      contracts: ids.map((id) => ({ ...game, functionName: "getRound" as const, args: [id] as const })),
      allowFailure: false,
    });
    for (const r of rounds) state.flights.set(r.player, (state.flights.get(r.player) ?? 0) + 1);
    state.scanned = to;
  }

  const players = [...state.flights.keys()];
  const balances: bigint[] = [];
  for (let i = 0; i < players.length; i += CHUNK) {
    const slice = players.slice(i, i + CHUNK);
    balances.push(
      ...(await client.multicall({
        contracts: slice.map((p) => ({ address: DEPLOYMENT.usd, abi: erc20Abi, functionName: "balanceOf" as const, args: [p] as const })),
        allowFailure: false,
      })),
    );
  }

  const entries = players
    .map((address, i) => ({ address, usdc: Number(balances[i]) / 10 ** USDC_DECIMALS, flights: state.flights.get(address) ?? 0 }))
    .sort((a, b) => b.usdc - a.usdc || b.flights - a.flights)
    .slice(0, MAX_ENTRIES);
  return {
    players: players.length,
    best: best > 0 ? { multiplier: best / 100, by: bestBy } : null,
    entries,
    updatedAt: Date.now(),
  };
}

export async function GET() {
  if (!state.board || Date.now() - state.board.updatedAt > FRESH_MS) {
    state.refreshing ??= refresh().finally(() => (state.refreshing = null));
    try {
      state.board = await state.refreshing;
    } catch (e) {
      // Serve the last good board through an RPC hiccup.
      if (!state.board) return NextResponse.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
    }
  }
  return NextResponse.json(state.board, { headers: { "Cache-Control": "public, s-maxage=4, stale-while-revalidate=30" } });
}
