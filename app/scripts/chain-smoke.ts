/**
 * Exercises lib/chain.ts outside the browser: burner wallet, funding, launch/cashOut/settle,
 * history. Usage (local anvil):
 *   NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8547 HOUSE_PRIVATE_KEY=0x… npx tsx scripts/chain-smoke.ts
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
} as Storage;

async function main() {
  const { createChain } = await import("../lib/chain");
  const { CHAIN, DEPLOYMENT, RPC_URL } = await import("../lib/config");
  const { jetxAbi } = await import("../lib/abi");
  const house = privateKeyToAccount(process.env.HOUSE_PRIVATE_KEY as Hex);
  const client = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
  const wallet = createWalletClient({ account: house, chain: CHAIN, transport: http(RPC_URL) });

  // Stand-in for POST /api/fund: same thresholds as the route.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== "/api/fund") return realFetch(url, init);
    const { address } = JSON.parse(String(init!.body));
    const mon = await client.getBalance({ address });
    let block = 0;
    if (mon < parseEther("0.05")) {
      const r = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: address, value: parseEther("0.2") }) });
      block = Number(r.blockNumber);
    }
    const { erc20Abi } = await import("../lib/abi");
    const usdc = await client.readContract({ address: DEPLOYMENT.usd, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    if (usdc < BigInt(5e6)) {
      const data = encodeFunctionData({ abi: jetxAbi, functionName: "grant", args: [address, BigInt(1000e6)] });
      const r = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: DEPLOYMENT.game, data }) });
      block = Math.max(block, Number(r.blockNumber));
    }
    return new Response(JSON.stringify({ ok: true, block }));
  }) as typeof fetch;

  const chain = createChain();
  const { address, balances } = await chain.ready();
  console.log("wallet", address, balances);
  if (balances.usdc < 1000 || balances.mon < 0.1) throw new Error("funding failed");

  let usdc = balances.usdc;
  const sample: Record<string, `0x${string}`> = {};
  const times: number[] = [];
  for (let i = 0; i < Number(process.env.FLIGHTS ?? 12); i++) {
    const flight = await chain.launch(10);
    times.push(flight.tx.confirmMs);
    sample.launch = flight.tx.hash;
    usdc -= 10;
    const target = [1.01, 1.5, 2, 3][i % 4];
    if (flight.crash >= target) {
      const { payout, tx } = await chain.cashOut(flight, target);
      times.push(tx.confirmMs);
      sample.cashOut = tx.hash;
      usdc += payout;
      console.log(`#${flight.id} crash ${flight.crash.toFixed(2)}x  cash out @${target}x  +${payout}`);
    } else {
      const { tx } = await chain.settle(flight);
      times.push(tx.confirmMs);
      sample.settle = tx.hash;
      console.log(`#${flight.id} crash ${flight.crash.toFixed(2)}x  lost 10`);
    }
    const b = await chain.balances();
    if (Math.abs(b.usdc - usdc) > 1e-6) throw new Error(`balance drift: ${b.usdc} vs ${usdc}`);
  }

  // Cash out exactly at the crash point is allowed.
  const f = await chain.launch(5);
  const { payout } = await chain.cashOut(f, f.crash);
  console.log(`cash out at crash ${f.crash}x → +${payout}`);

  // Relaunching with an unfinished flight forfeits it (page closed mid-flight).
  const a = await chain.launch(1);
  await chain.launch(1);
  const round = await client.readContract({ address: DEPLOYMENT.game, abi: jetxAbi, functionName: "getRound", args: [a.id] });
  if (round.status !== 3) throw new Error("abandoned flight not forfeited");

  const history = await chain.history();
  console.log("history", history.slice(0, 8).join(", "), `(${history.length})`);
  console.log(`tx confirm ms: median ${times.sort((x, y) => x - y)[times.length >> 1]}, max ${Math.max(...times)}`);
  for (const [label, hash] of Object.entries(sample)) {
    const r = await client.getTransactionReceipt({ hash });
    const tx = await client.getTransaction({ hash });
    console.log(`${label.padEnd(8)} gasUsed ${r.gasUsed} limit ${tx.gas} cost ${(Number(r.gasUsed * r.effectiveGasPrice) / 1e18).toFixed(4)} MON`);
  }
  console.log("OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
