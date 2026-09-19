/** One wallet: onboard, lose everything, refill() through the self-faucet, sweep MON back. */
import { createPublicClient, fallback, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { writeFileSync } from "node:fs";
import { createChain } from "../lib/chain";
import { CHAIN, DEPLOYMENT, RPC_URLS } from "../lib/config";

async function main() {
  const key = generatePrivateKey();
  writeFileSync(`/tmp/jetx-refill-${Date.now()}.json`, JSON.stringify([key]));
  const chain = createChain({ key, baseUrl: process.env.BASE_URL ?? "http://localhost:3200" });
  const r = await chain.ready();
  console.log("ready", r.balances);
  const f = await chain.launch(Math.min(1000, r.balances.usdc));
  await chain.settle(f);
  console.log("after loss", await chain.balances());
  const b = await chain.refill();
  console.log("after refill", b);
  if (b.usdc < 1000) throw new Error("refill failed");
  await new Promise((res) => setTimeout(res, 2500));
  const account = privateKeyToAccount(key);
  const client = createPublicClient({ chain: CHAIN, transport: fallback(RPC_URLS.map((u) => http(u))) });
  const bal = await client.getBalance({ address: account.address });
  const fees = await client.estimateFeesPerGas();
  const raw = await account.signTransaction({
    chainId: CHAIN.id, type: "eip1559", to: DEPLOYMENT.house, value: bal - BigInt(21_000) * fees.maxFeePerGas!, gas: BigInt(21_000),
    nonce: await client.getTransactionCount({ address: account.address, blockTag: "pending" }),
    maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
  });
  const rc = (await client.request({ method: "eth_sendRawTransactionSync" as never, params: [raw] as never })) as { status: Hex };
  console.log("swept", rc.status === "0x1");
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
