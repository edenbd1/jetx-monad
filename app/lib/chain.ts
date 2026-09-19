"use client";

import {
  createPublicClient,
  encodeFunctionData,
  fallback,
  formatEther,
  http,
  keccak256,
  parseEventLogs,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { erc20Abi, jetxAbi } from "./abi";
import { CHAIN, DEPLOYMENT, EXPLORER_URL, HIGH_CAPACITY_RPCS, RPC_URLS } from "./config";
import { toX100, type Address, type Balances, type Flight, type GameChain, type Hash, type TxInfo } from "./game-types";

const WALLET_KEY = "jetx-wallet-v1";
const USDC = 1e6;
/** Monad bills the full gas limit, so keep the headroom small. */
const GAS_HEADROOM = 1.1;
/**
 * Fixed gas limits (measured estimates + ~25%), so a tap never waits on eth_estimateGas and a
 * crowd of players doesn't burn the RPC budget. A tx that still runs out is re-sent with a fresh
 * estimate. Measured on testnet: launch ~146k, cashOut ~96k, settle ~76k, faucet ~84k.
 */
const GAS: Record<Method, bigint> = {
  launch: BigInt(200_000),
  cashOut: BigInt(130_000),
  settle: BigInt(105_000),
  faucet: BigInt(110_000),
};
const FEE_TTL_MS = 5 * 60_000;
/** Monad's 3-block delayed state after a top-up is included (~0.4 s blocks), plus margin. */
const FUNDING_SETTLE_MS = 1_800;
/** Ask the house for gas below this balance (a flight costs ~0.025 MON). */
const LOW_MON = 0.04;

type Method = "launch" | "cashOut" | "settle" | "faucet";
type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; at: number };
type RawReceipt = { status: Hex; blockNumber: Hex; transactionHash: Hash; logs: TransactionReceipt["logs"] };

export type ChainOptions = {
  /** Wallet key; defaults to the burner kept in this browser's localStorage. */
  key?: Hex;
  /** Origin of the app serving /api/fund; defaults to the current page (relative URL). */
  baseUrl?: string;
};

/** The managed wallet: a burner key kept in this browser. No connect, no popups. */
function loadKey(): Hex {
  let key = localStorage.getItem(WALLET_KEY) as Hex | null;
  if (!key) {
    key = generatePrivateKey();
    localStorage.setItem(WALLET_KEY, key);
  }
  return key;
}

function shuffle<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Errors worth trying the next RPC for: network, timeouts, rate limits, server errors. */
const RETRYABLE =
  /fetch failed|network|timed? ?out|timeout|ECONN|ENOTFOUND|socket|429|too many|rate|limit exceeded|50[0-9]|bad gateway|unavailable|not (found|supported|available)|does not exist|unknown method/i;
/** The tx already reached a node (e.g. a send that timed out but went through): wait for its receipt. */
const ALREADY_SENT = /already known|known transaction|already imported|nonce too low/i;

export function createChain(opts: ChainOptions = {}): GameChain {
  const account = privateKeyToAccount(opts.key ?? loadKey());
  const fundUrl = `${opts.baseUrl ?? ""}/api/fund`;
  // Each player gets its own random order over the high-capacity RPCs (per-IP limits: 30 phones
  // share one venue IP), and fails over through the rest.
  const urls = [...shuffle(RPC_URLS.slice(0, HIGH_CAPACITY_RPCS)), ...RPC_URLS.slice(HIGH_CAPACITY_RPCS)];
  const client = createPublicClient({
    chain: CHAIN,
    transport: fallback(
      urls.map((url) => http(url, { retryCount: 1, timeout: 8_000 })),
      { retryCount: 2 },
    ),
    pollingInterval: 150,
  });
  // One client per RPC for sends, tried in the same order.
  const senders: PublicClient[] = urls.map((url) =>
    createPublicClient({ chain: CHAIN, transport: http(url, { retryCount: 0, timeout: 12_000 }) }),
  );
  const game = DEPLOYMENT.game;

  let nonce: number | null = null;
  let fees: Fees | null = null;
  const gasCache = new Map<Method, bigint>();
  let lastMon = 1;

  // Concurrent callers share one in-flight lookup (ready() warms both while the first send starts).
  let feesLoading: Promise<Fees> | null = null;
  let nonceLoading: Promise<number> | null = null;

  async function getFees(): Promise<Fees> {
    if (fees && Date.now() - fees.at <= FEE_TTL_MS) return fees;
    feesLoading ??= client
      .estimateFeesPerGas()
      .then((f) => {
        const fresh: Fees = { maxFeePerGas: f.maxFeePerGas!, maxPriorityFeePerGas: f.maxPriorityFeePerGas!, at: Date.now() };
        fees = fresh;
        return fresh;
      })
      .finally(() => (feesLoading = null));
    return feesLoading;
  }

  async function getNonce(): Promise<number> {
    if (nonce !== null) return nonce;
    nonceLoading ??= client
      .getTransactionCount({ address: account.address, blockTag: "pending" })
      .then((n) => (nonce = n))
      .finally(() => (nonceLoading = null));
    return nonceLoading;
  }

  async function estimate(method: Method, data: Hex) {
    const gas = await client.estimateGas({ account: account.address, to: game, data });
    const limit = BigInt(Math.ceil(Number(gas) * GAS_HEADROOM));
    gasCache.set(method, limit);
    return limit;
  }

  /** Signs locally and sends with eth_sendRawTransactionSync: one round trip returns the receipt. */
  async function send(method: Method, data: Hex, { fresh = false } = {}): Promise<{ tx: TxInfo; receipt: RawReceipt }> {
    const t0 = performance.now();
    const [gas, fee, n] = await Promise.all([
      fresh ? estimate(method, data) : (gasCache.get(method) ?? GAS[method]),
      getFees(),
      getNonce(),
    ]);
    let receipt: RawReceipt;
    try {
      receipt = await submitWhenFunded((bump) =>
        account.signTransaction({
          chainId: CHAIN.id,
          type: "eip1559",
          to: game,
          data,
          gas,
          nonce: n,
          maxFeePerGas: fee.maxFeePerGas + bump,
          maxPriorityFeePerGas: fee.maxPriorityFeePerGas + bump,
        }),
      );
    } catch (e) {
      nonce = null; // resync on any failure (nonce race, dropped tx…)
      if (!fresh && /gas|out of gas/i.test(String(e))) return send(method, data, { fresh: true });
      throw e;
    }
    nonce = n + 1;
    if (receipt.status !== "0x1") {
      if (!fresh) return send(method, data, { fresh: true });
      throw new Error(`${method} reverted`);
    }
    return {
      tx: { hash: receipt.transactionHash, confirmMs: Math.round(performance.now() - t0), block: Number(receipt.blockNumber) },
      receipt,
    };
  }

  /**
   * Monad's consensus checks balances against state 3 blocks behind the tip (reserve balance rule),
   * so a wallet funded a moment ago is briefly "empty". Nodes also cache a rejection per raw
   * transaction, so each retry is re-signed with a 1-wei higher tip to be evaluated afresh.
   */
  async function submitWhenFunded(sign: (bump: bigint) => Promise<Hex>): Promise<RawReceipt> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await submit(await sign(BigInt(attempt)));
      } catch (e) {
        if (attempt >= 10 || !/insufficient balance/i.test(String(e))) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /**
   * Lets a fresh top-up clear Monad's 3-block delayed-state window before the first send. A plain
   * wait (no block polling) keeps the RPC budget for the crowd; late cases are covered by the
   * insufficient-balance retries in submitWhenFunded.
   */
  async function settleFunding(block: number | undefined) {
    if (block) await new Promise((r) => setTimeout(r, FUNDING_SETTLE_MS));
  }

  /** Sends through each RPC in turn; moves on only for transport-level failures. */
  async function submit(raw: Hex): Promise<RawReceipt> {
    let lastError: unknown;
    for (const sender of senders) {
      try {
        return (await sender.request({ method: "eth_sendRawTransactionSync" as never, params: [raw] as never })) as RawReceipt;
      } catch (e) {
        const msg = `${String(e)} ${(e as { details?: string }).details ?? ""}`;
        if (ALREADY_SENT.test(msg)) return waitFor(keccak256(raw));
        if (!RETRYABLE.test(msg) || /insufficient balance/i.test(msg)) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  async function waitFor(hash: Hash): Promise<RawReceipt> {
    const r = await client.waitForTransactionReceipt({ hash, pollingInterval: 150, timeout: 30_000 });
    return {
      status: r.status === "success" ? "0x1" : "0x0",
      blockNumber: `0x${r.blockNumber.toString(16)}`,
      transactionHash: r.transactionHash,
      logs: r.logs,
    };
  }

  /** Asks the house for gas (MON). USDC is claimed by the wallet itself with JetX.faucet(). */
  async function fund() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(fundUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: account.address }),
      }).catch(() => undefined);
      const body = (await res?.json().catch(() => ({}))) as { block?: number; ok?: boolean };
      if (res?.ok && body.ok) return settleFunding(body.block);
      await new Promise((r) => setTimeout(r, 600 + Math.random() * 900));
    }
  }

  /** Claims 1,000 test USDC from the game when (nearly) broke. The wallet pays the gas. */
  async function claimUsdc() {
    await send("faucet", encodeFunctionData({ abi: jetxAbi, functionName: "faucet" }));
  }

  async function balances(): Promise<Balances> {
    const [usdc, mon] = await Promise.all([
      client.readContract({ address: DEPLOYMENT.usd, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      client.getBalance({ address: account.address }),
    ]);
    lastMon = Number(formatEther(mon));
    return { usdc: Number(usdc) / USDC, mon: lastMon };
  }

  const chain: GameChain = {
    async ready() {
      let now = await balances();
      if (now.mon < LOW_MON) {
        await fund();
        now = await balances();
      }
      getFees().catch(() => undefined);
      getNonce().catch(() => undefined);
      if (now.usdc < 1 && now.mon > 0) {
        await claimUsdc();
        now = await balances();
      }
      return { address: account.address, balances: now };
    },

    balances,

    async launch(bet) {
      if (lastMon < LOW_MON) await fund();
      const { tx, receipt } = await send(
        "launch",
        encodeFunctionData({ abi: jetxAbi, functionName: "launch", args: [BigInt(Math.round(bet * USDC))] }),
      );
      const startedAt = Date.now();
      const [launched] = parseEventLogs({ abi: jetxAbi, logs: receipt.logs as never, eventName: "Launched" });
      const id = launched.args.id;
      const round = await client.readContract({ address: game, abi: jetxAbi, functionName: "getRound", args: [id] });
      const crash = round.crash / 100;
      return { id, bet, crash, startedAt, tx } satisfies Flight;
    },

    async cashOut(flight, multiplier) {
      const x100 = Math.min(toX100(multiplier), Math.round(flight.crash * 100));
      const { tx } = await send("cashOut", encodeFunctionData({ abi: jetxAbi, functionName: "cashOut", args: [flight.id, x100] }));
      return { payout: (flight.bet * x100) / 100, tx };
    },

    async settle(flight) {
      const { tx } = await send("settle", encodeFunctionData({ abi: jetxAbi, functionName: "settle", args: [flight.id] }));
      return { tx };
    },

    async history() {
      const recent = await client.readContract({ address: game, abi: jetxAbi, functionName: "recentCrashes" });
      return recent.map((c) => c / 100);
    },

    async refill() {
      if (lastMon < LOW_MON) await fund();
      await claimUsdc();
      return balances();
    },

    explorerTx: (hash: Hash) => `${EXPLORER_URL}/tx/${hash}`,
    explorerAddress: (address: Address) => `${EXPLORER_URL}/address/${address}`,
  };
  return chain;
}
