import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient, createWalletClient, encodeFunctionData, http, isAddress, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, jetxAbi } from "@/lib/abi";
import { CHAIN, DEPLOYMENT, RPC_URL } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Players get gas (~4 flights) when they drop below MIN_MON, and 1,000 test USDC when nearly broke. */
const MIN_MON = parseEther("0.04");
const TOPUP_MON = parseEther("0.1");
const MIN_USDC = BigInt(5e6);
const GRANT_USDC = BigInt(1_000e6);

/** Per-IP budget (best effort, per server instance). */
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 12;
const hits = new Map<string, number[]>();

function limited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}

export async function POST(req: NextRequest) {
  const key = process.env.HOUSE_PRIVATE_KEY as Hex | undefined;
  if (!key) return NextResponse.json({ error: "house wallet not configured" }, { status: 503 });

  const { address } = (await req.json().catch(() => ({}))) as { address?: string };
  if (!address || !isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(ip)) return NextResponse.json({ error: "slow down" }, { status: 429 });

  const house = privateKeyToAccount(key);
  const transport = http(process.env.RPC_URL || RPC_URL, { retryCount: 2 });
  const client = createPublicClient({ chain: CHAIN, transport });
  const wallet = createWalletClient({ account: house, chain: CHAIN, transport });

  const [mon, usdc] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: DEPLOYMENT.usd, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);

  const sent: Record<string, string> = {};
  /** Block of the last funding tx: the client waits for Monad's 3-block delayed state to pass it. */
  let block = 0;
  // Two concurrent fundings can race on the house nonce: retry once with a fresh one.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let nonce = await client.getTransactionCount({ address: house.address, blockTag: "pending" });
      const hashes: Hex[] = [];
      if (mon < MIN_MON && !sent.mon) {
        hashes.push(await wallet.sendTransaction({ to: address, value: TOPUP_MON, nonce: nonce++ }));
        sent.mon = hashes.at(-1)!;
      }
      if (usdc < MIN_USDC && !sent.usdc) {
        hashes.push(
          await wallet.sendTransaction({
            to: DEPLOYMENT.game,
            data: encodeFunctionData({ abi: jetxAbi, functionName: "grant", args: [address, GRANT_USDC] }),
            nonce: nonce++,
          }),
        );
        sent.usdc = hashes.at(-1)!;
      }
      const receipts = await Promise.all(hashes.map((hash) => client.waitForTransactionReceipt({ hash, pollingInterval: 150 })));
      block = Math.max(0, ...receipts.map((r) => Number(r.blockNumber)));
      break;
    } catch (e) {
      if (attempt === 1) return NextResponse.json({ error: String(e).slice(0, 200), sent }, { status: 502 });
    }
  }
  return NextResponse.json({ ok: true, sent, block });
}
