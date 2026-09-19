import { NextResponse, type NextRequest } from "next/server";
import {
  createPublicClient,
  encodeFunctionData,
  fallback,
  formatEther,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseEther,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { CHAIN, DEPLOYMENT, RPC_URLS } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A burst of arrivals queues on the house nonce: give the function room past Vercel's 10 s default. */
export const maxDuration = 60;

/**
 * Gas sponsorship for managed wallets: players get 0.2 MON (~6 flights) when they drop below
 * 0.09 MON. USDC is claimed by the wallet itself (JetX.faucet). Concurrent arrivals are batched
 * into one GasSponsor.sponsor() call, so a burst costs a couple of house nonces, not one each.
 *
 * Monad reserve-balance rule: an account holding less than 10 MON may send only one value
 * transfer per 3 blocks (later ones revert and still burn gas). Above 10 MON it can send
 * back-to-back as long as it stays above 10 MON. So the house funds everyone from one key and
 * must be kept above 10 MON; below that it falls back to one transfer per 4 blocks.
 */
/**
 * Top up below 0.09 MON: Monad reserves gas_limit x max_fee for every in-flight tx, and a launch
 * plus its cash-out reserve ~0.04 MON together, so 0.04 was too tight by the third flight.
 */
const MIN_MON = parseEther("0.09");
const TOPUP_MON = parseEther("0.2");
/** Arrivals within this window share one sponsor transaction (one nonce for up to MAX_BATCH players). */
const BATCH_WINDOW_MS = 250;
const MAX_BATCH = 30;
const RESERVE = parseEther("10");
const TRANSFER_GAS = BigInt(21_000);

/** Abuse limits. Keyed per player: 30 phones share one venue IP, so the per-IP cap is loose. */
const WINDOW_MS = 10 * 60_000;
const MAX_PER_PLAYER = 8;
const MAX_PER_IP = 600;

type Result = { ok: true; sent: { mon?: Hash }; block: number } | { ok: false; error: string };

type Waiter = { player: Address; resolve: (hash: Hash) => void; reject: (e: unknown) => void };

type HouseState = {
  account: PrivateKeyAccount;
  client: PublicClient;
  senders: PublicClient[];
  nonce: number | null;
  queue: Promise<unknown>;
  lastSentBlock: number;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; at: number } | null;
  balance: { value: bigint; at: number } | null;
  batch: Waiter[];
  timer: ReturnType<typeof setTimeout> | null;
};

// Module state survives across requests on a warm instance (dev server, Vercel fluid compute).
const g = globalThis as unknown as {
  __jetxHouse?: HouseState;
  __jetxInflight?: Map<string, Promise<Result>>;
  __jetxHits?: Map<string, number[]>;
};
const inflight = (g.__jetxInflight ??= new Map<string, Promise<Result>>());
const hits = (g.__jetxHits ??= new Map<string, number[]>());

function limited(key: string, max: number) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}

function house(key: Hex): HouseState {
  if (!g.__jetxHouse) {
    const transports = RPC_URLS.map((url) => http(url, { retryCount: 1, timeout: 8_000 }));
    g.__jetxHouse = {
      account: privateKeyToAccount(key),
      client: createPublicClient({ chain: CHAIN, transport: fallback(transports, { retryCount: 2 }) }),
      senders: RPC_URLS.map((url) => createPublicClient({ chain: CHAIN, transport: http(url, { retryCount: 0, timeout: 10_000 }) })),
      nonce: null,
      queue: Promise.resolve(),
      lastSentBlock: 0,
      fees: null,
      balance: null,
      batch: [],
      timer: null,
    };
  }
  return g.__jetxHouse;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` after every previously queued send: nonces are assigned strictly in order. */
function serial<T>(h: HouseState, fn: () => Promise<T>): Promise<T> {
  const run = h.queue.then(fn, fn);
  h.queue = run.catch(() => undefined);
  return run;
}

async function fees(h: HouseState) {
  if (!h.fees || Date.now() - h.fees.at > 30_000) {
    const f = await h.client.estimateFeesPerGas();
    h.fees = { maxFeePerGas: f.maxFeePerGas!, maxPriorityFeePerGas: f.maxPriorityFeePerGas!, at: Date.now() };
  }
  return h.fees;
}

async function houseBalance(h: HouseState) {
  if (!h.balance || Date.now() - h.balance.at > 5_000) {
    h.balance = { value: await h.client.getBalance({ address: h.account.address }), at: Date.now() };
  }
  return h.balance.value;
}

/** Broadcasts through each RPC in turn; a node that already has the tx counts as sent. */
async function broadcast(h: HouseState, raw: Hex): Promise<Hash> {
  let last: unknown;
  for (const s of h.senders) {
    try {
      return await s.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      const msg = `${String(e)} ${(e as { details?: string }).details ?? ""}`;
      if (/already known|known transaction|already imported/i.test(msg)) return keccak256(raw);
      if (/nonce too low|nonce.*(low|used)|replacement|underpriced|insufficient/i.test(msg)) throw e;
      last = e;
    }
  }
  throw last;
}

const sponsorAbi = parseAbi(["function sponsor(address[] players, uint256 each) payable"]);

/** Signs and broadcasts one sponsor() call for `players` with the next house nonce. */
function sendBatch(h: HouseState, players: Address[]): Promise<Hash> {
  return serial(h, async () => {
    const value = TOPUP_MON * BigInt(players.length);
    const data = encodeFunctionData({ abi: sponsorAbi, functionName: "sponsor", args: [players, TOPUP_MON] });
    for (let attempt = 0; ; attempt++) {
      try {
        if (h.nonce === null) h.nonce = await h.client.getTransactionCount({ address: h.account.address, blockTag: "pending" });
        // Below the 10 MON reserve the house may only send one value transfer per 3 blocks.
        const balance = await houseBalance(h);
        const paced = balance < RESERVE + value * BigInt(2);
        if (paced) {
          for (let i = 0; i < 30; i++) {
            if (Number(await h.client.getBlockNumber()) >= h.lastSentBlock + 4) break;
            await sleep(200);
          }
        }
        const f = await fees(h);
        const gas = await h.client.estimateGas({ account: h.account.address, to: DEPLOYMENT.sponsor, data, value });
        const raw = await h.account.signTransaction({
          chainId: CHAIN.id,
          type: "eip1559",
          to: DEPLOYMENT.sponsor,
          data,
          value,
          gas: (gas * BigInt(11)) / BigInt(10),
          nonce: h.nonce,
          maxFeePerGas: f.maxFeePerGas,
          maxPriorityFeePerGas: f.maxPriorityFeePerGas,
        });
        const hash = await broadcast(h, raw);
        h.nonce += 1;
        if (h.balance) h.balance.value -= value;
        if (paced) h.lastSentBlock = Number(await h.client.getBlockNumber().catch(() => BigInt(h.lastSentBlock)));
        return hash;
      } catch (e) {
        h.nonce = null; // another instance or a dropped tx moved the nonce: resync and retry
        if (attempt >= 3) throw e;
        await sleep(150 + Math.random() * 350);
      }
    }
  });
}

/** Queues a player into the next sponsor() batch; resolves with that batch's tx hash. */
function enqueue(h: HouseState, player: Address): Promise<Hash> {
  return new Promise((resolve, reject) => {
    h.batch.push({ player, resolve, reject });
    const flush = () => {
      if (h.timer) clearTimeout(h.timer);
      h.timer = null;
      const waiters = h.batch.splice(0, MAX_BATCH);
      if (h.batch.length) h.timer = setTimeout(flush, 0);
      sendBatch(
        h,
        waiters.map((w) => w.player),
      ).then(
        (hash) => waiters.forEach((w) => w.resolve(hash)),
        (e) => waiters.forEach((w) => w.reject(e)),
      );
    };
    if (h.batch.length >= MAX_BATCH) flush();
    else if (!h.timer) h.timer = setTimeout(flush, BATCH_WINDOW_MS);
  });
}

async function fund(h: HouseState, player: Address): Promise<Result> {
  const mon = await h.client.getBalance({ address: player });
  if (mon >= MIN_MON) return { ok: true, sent: {}, block: 0 };
  let error = "top-up kept reverting";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (attempt > 0 && (await h.client.getBalance({ address: player })) >= MIN_MON) return { ok: true, sent: {}, block: 0 };
      const hash = await enqueue(h, player);
      // Monad confirms in under a second: a tx that isn't in after 6 s lost a nonce race with another
      // instance and was dropped, so re-queue instead of waiting out a long timeout.
      const receipt = await h.client.waitForTransactionReceipt({ hash, pollingInterval: 150, timeout: 6_000 });
      if (receipt.status === "success") return { ok: true, sent: { mon: hash }, block: Number(receipt.blockNumber) };
      // A reverted batch (reserve rule) still consumed a nonce: just go again.
    } catch (e) {
      error = String(e).slice(0, 200);
    }
    await sleep(300);
  }
  return { ok: false, error };
}

export async function POST(req: NextRequest) {
  const key = process.env.HOUSE_PRIVATE_KEY as Hex | undefined;
  if (!key) return NextResponse.json({ ok: false, error: "house wallet not configured" }, { status: 503 });

  const { address } = (await req.json().catch(() => ({}))) as { address?: string };
  if (!address || !isAddress(address)) return NextResponse.json({ ok: false, error: "bad address" }, { status: 400 });
  const player = address.toLowerCase() as Address;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

  // Concurrent calls for the same wallet share one funding.
  const pending = inflight.get(player);
  if (pending) {
    const shared = await pending;
    return NextResponse.json(shared, { status: shared.ok ? 200 : 502 });
  }
  if (limited(`p:${player}`, MAX_PER_PLAYER) || limited(`ip:${ip}`, MAX_PER_IP)) {
    return NextResponse.json({ ok: false, error: "slow down" }, { status: 429 });
  }

  const job = fund(house(key), player).finally(() => inflight.delete(player));
  inflight.set(player, job);
  const result = await job;
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}

/** House health for the demo: balance and headroom above Monad's 10 MON reserve. */
export async function GET() {
  const key = process.env.HOUSE_PRIVATE_KEY as Hex | undefined;
  if (!key) return NextResponse.json({ ok: false, error: "house wallet not configured" }, { status: 503 });
  const h = house(key);
  const balance = await h.client.getBalance({ address: h.account.address });
  const headroom = balance > RESERVE ? balance - RESERVE : BigInt(0);
  return NextResponse.json({
    ok: true,
    house: h.account.address,
    balance: formatEther(balance),
    fastFunding: balance >= RESERVE + TOPUP_MON * BigInt(2),
    playersBeforeReserve: Number(headroom / TOPUP_MON),
  });
}
