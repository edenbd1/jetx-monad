# JetX · Monad

A mobile rocket crash game on Monad Testnet, with Kaaris live on the mic. Tap to bet, watch the rocket climb, cash out before it blows up.

Built at **Monad Blitz Paris** (19 September 2026).

## How it plays

- **No wallet to connect.** The first visit creates a wallet in the browser; the house tops it up with gas (MON) and 1,000 test USDC.
- **Two transactions per rocket.** `launch(bet)` when you tap BET (the bet is burned and the crash point drawn), then `cashOut(id, multiplier)` when you tap CASH OUT, or `settle(id)` once the rocket has blown up. Every flight is on-chain and linked to the explorer.
- **Instant on Monad.** Transactions are signed in the browser with a pre-warmed nonce, fees and gas limit, and sent with `eth_sendRawTransactionSync`: one round trip returns the receipt, in about half a second.
- **Kaaris reacts live.** A facecam bubble plays cuts from Kaaris's rocket-game ad depending on the flight: the intro on landing, "10 balles" on your bet, "ça monte bien comme il faut" on the way up, "Thomas Pesquet" past 5x, "je m'arrête à 6" or "bim bam boom" when you cash out, "putain" or "c'est grave la haine" when it crashes.

## Game math

Multipliers are x100 fixed point on-chain. The crash point follows the classic crash-game distribution:

```
P(crash ≥ x) = 0.97 / x        (3% house edge, capped at 1000x)
```

The rocket's multiplier grows as `m(t) = e^(0.1·t)` (2x after ~7 s, 5x after ~16 s, 10x after ~23 s). A cash-out can never exceed the flight's crash point. Launching again forfeits an unfinished flight, and anyone can close a flight abandoned for an hour.

## Contracts

| Contract | Role |
| --- | --- |
| `JetX` | The game: `launch`, `cashOut`, `settle`, recent crash history, stats, faucet, house `grant`. |
| `JetUSD` | 6-decimal test USDC. Only the game mints (payouts, faucet) and burns (bets), so playing never needs an approval. |

Randomness comes from block data at launch. That is fine for a testnet game with test dollars, but the crash point is readable once the launch is mined; a real-money version would draw it from a VRF or a commit-reveal house seed.

## Repo layout

```
contracts/   Foundry: src/JetX.sol, src/JetUSD.sol, tests (incl. distribution check), deploy script
app/         Next.js mobile game: rocket canvas, bet panel, Kaaris clip engine, managed wallet, /api/fund
app/public/kaaris/   24 reaction clips + clips.json (caption, trigger)
```

## Run it

```bash
cd contracts && forge test
source .env && forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast   # writes deployments/10143.json
cp deployments/10143.json ../app/lib/deployments/

cd ../app && pnpm install
HOUSE_PRIVATE_KEY=0x… pnpm dev             # the house key funds new players
NEXT_PUBLIC_CHAIN_MODE=mock pnpm dev      # UI only, no chain
```
