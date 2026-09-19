import type { Address } from "./game-types";

/** GET /api/leaderboard: every player who flew, richest first. */
export type LeaderboardEntry = { address: Address; usdc: number; flights: number };
export type Leaderboard = {
  players: number;
  best: { multiplier: number; by: Address } | null;
  entries: LeaderboardEntry[];
  updatedAt: number;
};
