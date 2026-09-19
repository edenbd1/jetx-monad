/**
 * Load test: N managed-wallet players hit the game at once, through the real /api/fund route and
 * the real chain layer (lib/chain.ts), on Monad testnet.
 *
 *   N=30 F=3 BASE_URL=http://localhost:3200 ARRIVAL_MS=10000 npx tsx scripts/load-test.ts
 *
 * N           players (default 30)
 * F           flights per player (default 3)
 * ARRIVAL_MS  players arrive uniformly over this window (default 10000; 0 = all at once)
 *
 * Each player: ready() (house gas top-up + self-claimed USDC), then F flights: bet 1–10 USDC,
 * cash out at 1.2x when the crash allows it, else settle, with 0.5–2 s think time. Leftover MON
 * is swept back to the house at the end. Test keys are saved to /tmp/jetx-load-<ts>.json first;
 * if a run dies, recover the MON with:  SWEEP_FILE=/tmp/jetx-load-<ts>.json npx tsx scripts/load-test.ts
 */
import { createPublicClient, fallback, formatEther, http, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { createChain } from "../lib/chain";
import { CHAIN, DEPLOYMENT, RPC_URLS } from "../lib/config";
import { msToReach } from "../lib/game-types";

const N = Number(process.env.N ?? 30);
const F = Number(process.env.F ?? 3);
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3200";
const ARRIVAL_MS = Number(process.env.ARRIVAL_MS ?? 10_000);
const HOUSE = DEPLOYMENT.house;
const readTransport = () => fallback(RPC_URLS.map((u) => http(u, { retryCount: 1 })), { retryCount: 3 });

type Step = "fund-http" | "ready" | "launch" | "cashOut" | "settle" | "sweep";
const samples: Record<Step, number[]> = { "fund-http": [], ready: [], launch: [], cashOut: [], settle: [], sweep: [] };
const failures: { step: Step | "balance"; player: number; error: string }[] = [];
const rpcCalls = new Map<string, number>();
const rpcMethods = new Map<string, number>();
const rpcStatus = new Map<string, number>();
let fundCalls = 0;

// Instrument fetch: time /api/fund calls and count JSON-RPC requests per host.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/api/fund")) {
    fundCalls += 1;
    const t0 = performance.now();
    const res = await realFetch(input, init);
    samples["fund-http"].push(performance.now() - t0);
    if (!res.ok) failures.push({ step: "fund-http", player: -1, error: `HTTP ${res.status} ${await res.clone().text()}` });
    return res;
  }
  const host = new URL(url).host;
  rpcCalls.set(host, (rpcCalls.get(host) ?? 0) + 1);
  try {
    const body = JSON.parse(String(init?.body ?? "{}"));
    for (const m of Array.isArray(body) ? body : [body]) rpcMethods.set(m.method, (rpcMethods.get(m.method) ?? 0) + 1);
  } catch {}
  const res = await realFetch(input, init);
  if (!res.ok) rpcStatus.set(`${host} ${res.status}`, (rpcStatus.get(`${host} ${res.status}`) ?? 0) + 1);
  return res;
}) as typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function timed<T>(step: Step, player: number, fn: () => Promise<T>): Promise<T | undefined> {
  const t0 = performance.now();
  try {
    const out = await fn();
    samples[step].push(performance.now() - t0);
    return out;
  } catch (e) {
    failures.push({ step, player, error: String((e as { shortMessage?: string }).shortMessage ?? e).slice(0, 160) });
    return undefined;
  }
}

async function play(i: number, key: Hex) {
  await sleep(ARRIVAL_MS ? Math.random() * ARRIVAL_MS : 0);
  const chain = createChain({ key, baseUrl: BASE_URL });
  const ready = await timed("ready", i, () => chain.ready());
  if (!ready) return;
  let expected = ready.balances.usdc;
  for (let f = 0; f < F; f++) {
    await sleep(500 + Math.random() * 1_500);
    const bet = 1 + Math.floor(Math.random() * 10);
    const flight = await timed("launch", i, () => chain.launch(bet));
    if (!flight) continue;
    expected -= bet;
    if (flight.crash >= 1.3) {
      await sleep(Math.max(0, msToReach(1.2) - (Date.now() - flight.startedAt)));
      const out = await timed("cashOut", i, () => chain.cashOut(flight, 1.2));
      if (out) expected += out.payout;
    } else {
      await sleep(Math.max(0, msToReach(flight.crash) - (Date.now() - flight.startedAt)));
      await timed("settle", i, () => chain.settle(flight));
    }
  }
  const b = await chain.balances().catch(() => undefined);
  if (b && Math.abs(b.usdc - expected) > 1e-6) failures.push({ step: "balance", player: i, error: `USDC ${b.usdc} != expected ${expected}` });
}

/** Sends a test wallet's leftover MON back to the house (after Monad's 3-block window). */
async function sweep(i: number, key: Hex) {
  const account = privateKeyToAccount(key);
  const client = createPublicClient({ chain: CHAIN, transport: readTransport() });
  const balance = await client.getBalance({ address: account.address });
  const fees = await client.estimateFeesPerGas();
  const cost = BigInt(21_000) * fees.maxFeePerGas!;
  if (balance <= cost * BigInt(2)) return BigInt(0);
  const value = balance - cost;
  await timed("sweep", i, async () => {
    const raw = await account.signTransaction({
      chainId: CHAIN.id,
      type: "eip1559",
      to: HOUSE,
      value,
      gas: BigInt(21_000),
      nonce: await client.getTransactionCount({ address: account.address, blockTag: "pending" }),
      maxFeePerGas: fees.maxFeePerGas!,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
    });
    const r = (await client.request({ method: "eth_sendRawTransactionSync" as never, params: [raw] as never })) as { status: Hex };
    if (r.status !== "0x1") throw new Error("sweep reverted");
  });
  return value;
}

async function main() {
  if (process.env.SWEEP_FILE) {
    const saved = JSON.parse(readFileSync(process.env.SWEEP_FILE, "utf8")) as Hex[];
    const back = (await Promise.all(saved.map((k, i) => sweep(i, k).catch(() => BigInt(0))))).reduce((a, b) => a + b, BigInt(0));
    console.log(`swept ${formatEther(back)} MON back from ${saved.length} wallets; failures: ${failures.length}`);
    return;
  }
  const reader = createPublicClient({ chain: CHAIN, transport: readTransport() });
  const houseBefore = await reader.getBalance({ address: HOUSE });
  const keys = Array.from({ length: N }, () => generatePrivateKey());
  const keyFile = `/tmp/jetx-load-${Date.now()}.json`;
  writeFileSync(keyFile, JSON.stringify(keys));
  console.log(`test keys saved to ${keyFile}`);
  console.log(`load test: ${N} players × ${F} flights, arrivals over ${ARRIVAL_MS} ms, ${BASE_URL}`);
  const t0 = performance.now();
  await Promise.all(keys.map((k, i) => play(i, k)));
  const elapsed = (performance.now() - t0) / 1000;

  await sleep(2_500); // let the last txs clear Monad's 3-block window before sweeping
  const swept = (await Promise.all(keys.map((k, i) => sweep(i, k).catch(() => BigInt(0))))).reduce((a, b) => a + b, BigInt(0));
  const houseAfter = await reader.getBalance({ address: HOUSE });

  const jetx = parseAbi(["function roundCount() view returns (uint256)"]);
  const rounds = await reader.readContract({ address: DEPLOYMENT.game, abi: jetx, functionName: "roundCount" });

  console.log(`\ndone in ${elapsed.toFixed(1)} s — ${fundCalls} /api/fund calls, game roundCount now ${rounds}`);
  console.log("\nstep        n    p50 ms  p95 ms  max ms");
  for (const step of Object.keys(samples) as Step[]) {
    const xs = samples[step];
    console.log(
      `${step.padEnd(10)} ${String(xs.length).padStart(3)} ${pct(xs, 50).toFixed(0).padStart(8)} ${pct(xs, 95).toFixed(0).padStart(7)} ${Math.max(0, ...xs).toFixed(0).padStart(7)}`,
    );
  }
  const flights = samples.launch.length;
  const rpcTotal = [...rpcCalls.values()].reduce((a, b) => a + b, 0);
  console.log(`\nRPC requests: ${rpcTotal} (${(rpcTotal / Math.max(1, flights)).toFixed(1)} per flight, ${(rpcTotal / elapsed).toFixed(1)}/s overall)`);
  for (const [host, n] of rpcCalls) console.log(`  ${host}: ${n}`);
  console.log("by method:", Object.fromEntries([...rpcMethods].sort((a, b) => b[1] - a[1])));
  console.log("HTTP errors:", Object.fromEntries(rpcStatus));
  console.log(`\nfailures: ${failures.length}`);
  const byKind = new Map<string, number>();
  for (const f of failures) byKind.set(`${f.step}: ${f.error}`, (byKind.get(`${f.step}: ${f.error}`) ?? 0) + 1);
  for (const [k, n] of byKind) console.log(`  ${n}× ${k}`);
  console.log(`\nMON: house ${formatEther(houseBefore)} → ${formatEther(houseAfter)} (net ${formatEther(houseAfter - houseBefore)}), swept back ${formatEther(swept)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
