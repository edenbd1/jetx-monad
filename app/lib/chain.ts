"use client";

import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  http,
  parseEventLogs,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { erc20Abi, jetxAbi } from "./abi";
import { CHAIN, DEPLOYMENT, EXPLORER_URL, RPC_URL } from "./config";
import { toX100, type Address, type Balances, type Flight, type GameChain, type Hash, type TxInfo } from "./game-types";

const WALLET_KEY = "jetx-wallet-v1";
const USDC = 1e6;
/** Monad bills the full gas limit, so keep the headroom small. */
const GAS_HEADROOM = 1.1;
const FEE_TTL_MS = 30_000;
/** Ask the house for gas below this balance (a flight costs ~0.02 MON). */
const LOW_MON = 0.05;

type Method = "launch" | "cashOut" | "settle";
type RawReceipt = { status: Hex; blockNumber: Hex; transactionHash: Hash; logs: TransactionReceipt["logs"] };

/** The managed wallet: a burner key kept in this browser. No connect, no popups. */
function loadKey(): Hex {
  let key = localStorage.getItem(WALLET_KEY) as Hex | null;
  if (!key) {
    key = generatePrivateKey();
    localStorage.setItem(WALLET_KEY, key);
  }
  return key;
}

export function createChain(): GameChain {
  const account = privateKeyToAccount(loadKey());
  const client = createPublicClient({ chain: CHAIN, transport: http(RPC_URL, { retryCount: 2 }), pollingInterval: 100 });
  const game = DEPLOYMENT.game;

  let nonce: number | null = null;
  let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; at: number } | null = null;
  const gasCache = new Map<Method, bigint>();
  let lastMon = 1;
  let syncSupported = true;

  async function getFees() {
    if (!fees || Date.now() - fees.at > FEE_TTL_MS) {
      const f = await client.estimateFeesPerGas();
      fees = { maxFeePerGas: f.maxFeePerGas!, maxPriorityFeePerGas: f.maxPriorityFeePerGas!, at: Date.now() };
    }
    return fees;
  }

  async function getNonce() {
    if (nonce === null) nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
    return nonce;
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
      !fresh && gasCache.get(method) ? gasCache.get(method)! : estimate(method, data),
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

  /** Waits until the funding block is outside Monad's 3-block delayed-state window. */
  async function settleFunding(block: number | undefined) {
    if (!block) return;
    for (let i = 0; i < 25; i++) {
      if (Number(await client.getBlockNumber()) >= block + 4) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function submit(raw: Hex): Promise<RawReceipt> {
    if (syncSupported) {
      try {
        return (await client.request({ method: "eth_sendRawTransactionSync" as never, params: [raw] as never })) as RawReceipt;
      } catch (e) {
        if (!/not (found|supported|available)|does not exist|unknown method/i.test(String(e))) throw e;
        syncSupported = false;
      }
    }
    const hash = await client.sendRawTransaction({ serializedTransaction: raw });
    const r = await client.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    return {
      status: r.status === "success" ? "0x1" : "0x0",
      blockNumber: `0x${r.blockNumber.toString(16)}`,
      transactionHash: r.transactionHash,
      logs: r.logs,
    };
  }

  async function fund() {
    const res = await fetch("/api/fund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: account.address }),
    }).catch(() => undefined);
    const body = (await res?.json().catch(() => ({}))) as { block?: number };
    await settleFunding(body.block);
  }

  async function balances(): Promise<Balances> {
    const [usdc, mon] = await Promise.all([
      client.readContract({ address: DEPLOYMENT.usd, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      client.getBalance({ address: account.address }),
    ]);
    lastMon = Number(formatEther(mon));
    return { usdc: Number(usdc) / USDC, mon: lastMon };
  }

  /** Warms the gas estimate for the next action so the tap sends immediately. */
  function prewarm(method: Method, data: Hex) {
    estimate(method, data).catch(() => undefined);
  }

  const chain: GameChain = {
    async ready() {
      const before = await balances();
      if (before.mon < LOW_MON || before.usdc < 1) await fund();
      const now = await balances();
      getFees().catch(() => undefined);
      getNonce().catch(() => undefined);
      if (now.usdc >= 1) prewarm("launch", encodeFunctionData({ abi: jetxAbi, functionName: "launch", args: [BigInt(USDC)] }));
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
      // Pre-estimate both endings while the rocket flies.
      prewarm("cashOut", encodeFunctionData({ abi: jetxAbi, functionName: "cashOut", args: [id, round.crash] }));
      prewarm("settle", encodeFunctionData({ abi: jetxAbi, functionName: "settle", args: [id] }));
      return { id, bet, crash, startedAt, tx } satisfies Flight;
    },

    async cashOut(flight, multiplier) {
      const x100 = Math.min(toX100(multiplier), Math.round(flight.crash * 100));
      const { tx } = await send("cashOut", encodeFunctionData({ abi: jetxAbi, functionName: "cashOut", args: [flight.id, x100] }));
      balances().catch(() => undefined);
      return { payout: (flight.bet * x100) / 100, tx };
    },

    async settle(flight) {
      const { tx } = await send("settle", encodeFunctionData({ abi: jetxAbi, functionName: "settle", args: [flight.id] }));
      balances().catch(() => undefined);
      return { tx };
    },

    async history() {
      const recent = await client.readContract({ address: game, abi: jetxAbi, functionName: "recentCrashes" });
      return recent.map((c) => c / 100);
    },

    async refill() {
      await fund();
      return balances();
    },

    explorerTx: (hash: Hash) => `${EXPLORER_URL}/tx/${hash}`,
    explorerAddress: (address: Address) => `${EXPLORER_URL}/address/${address}`,
  };
  return chain;
}
