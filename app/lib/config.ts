import { foundry, monadTestnet } from "viem/chains";
import type { Address } from "./game-types";
import local from "./deployments/31337.json";
import monad from "./deployments/10143.json";

export type Deployment = { chainId: number; startBlock: number; house: Address; usd: Address; game: Address };

/** NEXT_PUBLIC_CHAIN_ID=31337 runs against a local anvil; default is Monad Testnet. */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || monadTestnet.id);
export const CHAIN = CHAIN_ID === foundry.id ? foundry : monadTestnet;
export const DEPLOYMENT = (CHAIN_ID === foundry.id ? local : monad) as Deployment;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || CHAIN.rpcUrls.default.http[0];
export const EXPLORER_URL = "https://testnet.monadexplorer.com";
export const USDC_DECIMALS = 6;
