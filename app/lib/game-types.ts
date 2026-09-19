/**
 * Contract between the game UI and the chain layer. The UI only talks to a `GameChain`;
 * `lib/chain.ts` implements it on Monad (managed burner wallet + JetX contract) and
 * `lib/chain-mock.ts` implements it in memory for UI work without a chain.
 */

export type Hash = `0x${string}`;
export type Address = `0x${string}`;

/** A confirmed on-chain transaction, with how long Monad took to confirm it. */
export type TxInfo = {
  hash: Hash;
  /** Wall-clock ms from signing to receipt. */
  confirmMs: number;
  block: number;
};

export type Flight = {
  id: bigint;
  /** Bet in USDC (e.g. 10 = $10). */
  bet: number;
  /** Crash point as a multiplier (e.g. 2.37). Known once tx 1 is mined. */
  crash: number;
  /** Local timestamp (ms) at which the flight starts; the multiplier curve runs from here. */
  startedAt: number;
  tx: TxInfo;
};

export type Balances = { usdc: number; mon: number };

export interface GameChain {
  /** Loads (or creates) the managed wallet and makes sure it has gas + test USDC. */
  ready(): Promise<{ address: Address; balances: Balances }>;
  balances(): Promise<Balances>;
  /** Tx 1: burns the bet and draws the crash point. */
  launch(bet: number): Promise<Flight>;
  /** Tx 2 (win): cash out at `multiplier` (must be <= flight.crash). Returns the USDC paid. */
  cashOut(flight: Flight, multiplier: number): Promise<{ payout: number; tx: TxInfo }>;
  /** Tx 2 (loss): closes a flight that crashed. */
  settle(flight: Flight): Promise<{ tx: TxInfo }>;
  /** Last crash points, newest first. */
  history(): Promise<number[]>;
  /** Refills test USDC when the wallet is broke. */
  refill(): Promise<Balances>;
  explorerTx(hash: Hash): string;
  explorerAddress(address: Address): string;
}

/** Multiplier curve of the UI: m(t) = e^(GROWTH * seconds) (2x after ~8.7 s, 5x after ~20 s). */
export const GROWTH_PER_SECOND = 0.08;
export const multiplierAt = (elapsedMs: number) => Math.exp((GROWTH_PER_SECOND * Math.max(0, elapsedMs)) / 1000);
export const msToReach = (multiplier: number) => (Math.log(Math.max(1, multiplier)) / GROWTH_PER_SECOND) * 1000;
/** Multipliers are settled on-chain at 2 decimals (x100 fixed point), rounded down. */
export const toX100 = (m: number) => Math.floor(m * 100 + 1e-9);
