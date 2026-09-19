import { foundry, monadTestnet } from "viem/chains";
import type { Address } from "./game-types";
import local from "./deployments/31337.json";
import monad from "./deployments/10143.json";

export type Deployment = { chainId: number; startBlock: number; house: Address; usd: Address; game: Address };

/** NEXT_PUBLIC_CHAIN_ID=31337 runs against a local anvil; default is Monad Testnet. */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || monadTestnet.id);
export const CHAIN = CHAIN_ID === foundry.id ? foundry : monadTestnet;
export const DEPLOYMENT = (CHAIN_ID === foundry.id ? local : monad) as Deployment;
/**
 * Monad Testnet RPCs, all verified to serve reads and eth_sendRawTransactionSync, ordered by the
 * per-IP rate limit measured from one address (30 phones share one venue IP): ankr and
 * testnet-rpc.monad.xyz took 20 req/s without a 429, monadinfra ~13 req/s, thirdweb ~7 req/s.
 * Clients shuffle the first HIGH_CAPACITY_RPCS entries so players spread across them; the others
 * only take over on errors or 429s.
 */
const MONAD_RPCS = [
  "https://rpc.ankr.com/monad_testnet",
  "https://testnet-rpc.monad.xyz",
  "https://rpc-testnet.monadinfra.com",
  "https://10143.rpc.thirdweb.com",
];
export const HIGH_CAPACITY_RPCS = 2;
export const RPC_URLS: string[] = process.env.NEXT_PUBLIC_RPC_URL
  ? [process.env.NEXT_PUBLIC_RPC_URL]
  : CHAIN.id === monadTestnet.id
    ? MONAD_RPCS
    : [CHAIN.rpcUrls.default.http[0]];
export const RPC_URL = RPC_URLS[0];
export const EXPLORER_URL = "https://testnet.monadexplorer.com";
export const USDC_DECIMALS = 6;
