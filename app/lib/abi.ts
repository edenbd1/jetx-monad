import { parseAbi } from "viem";

export const jetxAbi = parseAbi([
  "struct Round { address player; uint96 bet; uint64 startedAt; uint32 crash; uint32 cashedAt; uint8 status; }",
  "function launch(uint256 bet) returns (uint256 id)",
  "function cashOut(uint256 id, uint32 multiplier) returns (uint256 payout)",
  "function settle(uint256 id)",
  "function faucet()",
  "function grant(address to, uint256 amount)",
  "function getRound(uint256 id) view returns (Round)",
  "function recentCrashes() view returns (uint32[])",
  "function activeRound(address player) view returns (uint256)",
  "function roundCount() view returns (uint256)",
  "function totalWagered() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
  "function bestCashOut() view returns (uint32)",
  "function bestCashOutBy() view returns (address)",
  "event Launched(uint256 indexed id, address indexed player, uint256 bet)",
  "event CashedOut(uint256 indexed id, address indexed player, uint32 multiplier, uint256 payout, uint32 crash)",
  "event Crashed(uint256 indexed id, address indexed player, uint256 bet, uint32 crash)",
]);

export const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
