import type { Address, Balances, Flight, GameChain, Hash, TxInfo } from "./game-types";
import { toX100 } from "./game-types";

/** In-memory GameChain for UI work: same rules as JetX.sol, fake confirmations. */
export function createMockChain(): GameChain {
  const address = "0xda7a00000000000000000000000000000000f05e" as Address;
  let usdc = 1_000;
  const mon = 0.5;
  let block = 4_200_000;
  let nextId = 1;
  const history: number[] = [];
  for (let i = 0; i < 14; i++) history.push(drawCrash());

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fakeHash = () =>
    `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}` as Hash;

  async function confirm(): Promise<TxInfo> {
    const confirmMs = 300 + Math.round(Math.random() * 600);
    await sleep(confirmMs);
    block += 1 + Math.floor(Math.random() * 3);
    return { hash: fakeHash(), confirmMs, block };
  }

  const balances = (): Balances => ({ usdc: Math.round(usdc * 1e6) / 1e6, mon });

  return {
    async ready() {
      await sleep(400);
      return { address, balances: balances() };
    },
    async balances() {
      return balances();
    },
    async launch(bet: number): Promise<Flight> {
      if (bet < 0.1 || bet > 1_000) throw new Error("Bet must be between $0.10 and $1,000");
      if (bet > usdc) throw new Error("Not enough USDC");
      const tx = await confirm();
      usdc -= bet;
      return { id: BigInt(nextId++), bet, crash: forcedCrash() ?? drawCrash(), startedAt: Date.now(), tx };
    },
    async cashOut(flight: Flight, multiplier: number) {
      const x100 = toX100(multiplier);
      if (x100 > Math.round(flight.crash * 100)) throw new Error("AboveCrash");
      const tx = await confirm();
      const payout = (flight.bet * x100) / 100;
      usdc += payout;
      history.unshift(flight.crash);
      return { payout, tx };
    },
    async settle(flight: Flight) {
      const tx = await confirm();
      history.unshift(flight.crash);
      return { tx };
    },
    async history() {
      return history.slice(0, 20);
    },
    async refill() {
      await confirm();
      if (usdc < 100) usdc += 1_000;
      return balances();
    },
    explorerTx: (hash: Hash) => `https://testnet.monadexplorer.com/tx/${hash}`,
    explorerAddress: (a: Address) => `https://testnet.monadexplorer.com/address/${a}`,
  };
}

/**
 * Mock only: `?crash=6.2` forces every flight's crash point, `?crash=1.3,5.6` plays them in turn
 * (cycling), for tests and rehearsed demos.
 */
let forcedIndex = 0;
function forcedCrash() {
  if (typeof window === "undefined") return null;
  const list = (new URLSearchParams(window.location.search).get("crash") ?? "")
    .split(",")
    .map(Number)
    .filter((v) => v >= 1);
  if (list.length === 0) return null;
  const v = list[forcedIndex++ % list.length];
  return Math.floor(v * 100) / 100;
}

/** P(crash >= x) = 0.97 / x, floored to 2 decimals like the contract. */
/** Same curve as JetX: base = 0.985 / x (1.5% busts), stretched 1.5x above 1x, capped at 50x. */
function drawCrash() {
  const r = Math.floor(Math.random() * 1e6);
  const base = Math.floor((9_850 * 1e6) / (1e6 - r));
  if (base <= 10_000) return 1;
  const x100 = Math.min(5_000, 100 + Math.floor(((base - 10_000) * 15_000) / 10_000 / 100 + 0.99));
  return x100 / 100;
}
