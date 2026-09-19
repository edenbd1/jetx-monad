import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const deployment = JSON.parse(readFileSync(`${here}../app/lib/deployments/10143.json`, "utf8")) as {
  game: Address;
  usd: Address;
  house: Address;
};

export const client = createPublicClient({ chain: monadTestnet, transport: http("https://rpc-testnet.monadinfra.com", { retryCount: 3 }) });

export const jetxAbi = parseAbi([
  "struct Round { address player; uint96 bet; uint64 startedAt; uint32 crash; uint32 cashedAt; uint8 status; }",
  "function getRound(uint256 id) view returns (Round)",
  "function activeRound(address player) view returns (uint256)",
  "function roundCount() view returns (uint256)",
  "function recentCrashes() view returns (uint32[])",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export const Status = { None: 0, Flying: 1, CashedOut: 2, Crashed: 3 } as const;

export const addressOfKey = (key: Hex) => privateKeyToAccount(key).address;
export const usdc = async (a: Address) =>
  Number(await client.readContract({ address: deployment.usd, abi: erc20Abi, functionName: "balanceOf", args: [a] })) / 1e6;
export const mon = async (a: Address) => Number(await client.getBalance({ address: a })) / 1e18;
export const activeRound = (a: Address) => client.readContract({ address: deployment.game, abi: jetxAbi, functionName: "activeRound", args: [a] });
export const round = (id: bigint) => client.readContract({ address: deployment.game, abi: jetxAbi, functionName: "getRound", args: [id] });
export const roundCount = () => client.readContract({ address: deployment.game, abi: jetxAbi, functionName: "roundCount" });

/** Latest round played by `player` (scans back from the newest round). */
export async function lastRoundOf(player: Address, scan = 40) {
  const count = await roundCount();
  for (let id = count; id > 0n && id > count - BigInt(scan); id--) {
    const r = await round(id);
    if (r.player.toLowerCase() === player.toLowerCase()) return { id, ...r };
  }
  return undefined;
}
