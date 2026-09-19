import { createChain } from "./chain";
import { createMockChain } from "./chain-mock";
import type { GameChain } from "./game-types";

let instance: GameChain | null = null;

/** The single GameChain for this tab: in-memory with NEXT_PUBLIC_CHAIN_MODE=mock, Monad otherwise. */
export function getChain(): GameChain {
  if (!instance) instance = process.env.NEXT_PUBLIC_CHAIN_MODE === "mock" ? createMockChain() : createChain();
  return instance;
}
