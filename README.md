# JetX · Monad

A mobile rocket crash game on Monad Testnet, with Kaaris live on the mic. Tap to bet, watch the rocket climb, cash out before it blows up.

**Play: https://jetx-monad.vercel.app** (on your phone; on desktop it opens in a phone frame)

Built at **Monad Blitz Paris** (19 September 2026).

![Splash, Kaaris intro, flight, cash out, crash](docs/strip.png)

## How it plays

- **No wallet to connect.** The first visit creates a wallet in the browser; the house tops it up with gas (MON) and 1,000 test USDC.
- **Two transactions per rocket.** `launch(bet)` when you tap BET (the bet is burned and the crash point drawn), then `cashOut(id, multiplier)` when you tap CASH OUT, or `settle(id)` once the rocket has blown up. Every flight is on-chain and linked to the explorer.
- **Instant on Monad.** Transactions are signed in the browser with a pre-warmed nonce, fees and gas limit, and sent with `eth_sendRawTransactionSync`: one round trip returns the receipt, in about half a second.
- **Kaaris reacts live, with the French meme crew.** A facecam bubble plays short cuts depending on the flight:
  - **start:** Kaaris only, "allez, je vais jouer 10 balles… c'est parti";
  - **climb:** Kaaris egging it on, Morsay's "ça c'est ma fusée" mid-flight, "Thomas Pesquet" past 5x, "on va tous mourir" at 12x, Les Visiteurs at 20x;
  - **cash out:** Eléonore under 1.2x (ironic), "je m'arrête à 6", "bim bam boom", SCH or "je suis riche" past 10x;
  - **after you cashed out:** "c'est grave la haine" as it keeps climbing, Jean Lassalle's "c'est pas fini ?" when it goes far;
  - **crash:** Denis Brogniart's "Ah !" on a 1.00x bust, "premier crash remboursé", then putain / Nils / Macron, Taxi 2's "catastrophe" on big crashes;
  - **idle / broke:** "laisse voler ton avion", Kaamelott, "swipe up", "c'est la hess".

## Game math

Multipliers are x100 fixed point on-chain. The crash point follows the classic crash-game distribution:

```
P(crash ≥ x) = 0.97 / x        (3% house edge, capped at 50x)
```

The rocket's multiplier grows as `m(t) = e^(0.1·t)` (2x after ~7 s, 5x after ~16 s, 10x after ~23 s). The cap is house-adjustable on-chain (`setMaxMultiplier`, between 2x and 1000x). A cash-out can never exceed the flight's crash point. Launching again forfeits an unfinished flight, and anyone can close a flight abandoned for an hour.

## Contracts

| Contract | Role |
| --- | --- |
| `JetX` | The game: `launch`, `cashOut`, `settle`, recent crash history, stats, faucet, house `grant`. |
| `JetUSD` | 6-decimal test USDC. Only the game mints (payouts, faucet) and burns (bets), so playing never needs an approval. |

Randomness comes from block data at launch. That is fine for a testnet game with test dollars, but the crash point is readable once the launch is mined; a real-money version would draw it from a VRF or a commit-reveal house seed.

## Deployment (Monad Testnet, chain 10143)

| Contract | Address |
| --- | --- |
| JetX | [`0xf6844e5DB26228BF9AFAF24F601456B506d818dB`](https://testnet.monadexplorer.com/address/0xf6844e5DB26228BF9AFAF24F601456B506d818dB) |
| JetUSD (test USDC) | [`0x539287813BEfeCfbFEF62038b9A2bBf0dc787A30`](https://testnet.monadexplorer.com/address/0x539287813BEfeCfbFEF62038b9A2bBf0dc787A30) |

Measured on testnet: `launch` 160k gas (0.016 MON), `cashOut` 105k (0.011 MON), `settle` 84k (0.009 MON). Sign-to-receipt median **~480 ms**.

## What we learned about Monad

- **`eth_sendRawTransactionSync` works** and returns the receipt in one round trip. Combined with a locally tracked nonce, cached fees and pre-estimated gas (estimated while the rocket flies), a tap becomes a confirmed transaction in about half a second.
- **Monad bills the gas limit, not the gas used.** Every receipt shows `gasUsed == gasLimit`, so the gas headroom is kept at 10%.
- **Reserve balance and delayed state.** Consensus checks balances against state 3 blocks behind the tip, so a wallet funded a moment ago is rejected with `Signer had insufficient balance`. Nodes also cache that rejection for the identical raw transaction, so naive retries fail forever. The app waits 4 blocks after a top-up and re-signs each retry with a 1-wei higher tip.

## Tests

- `contracts/`: 13 Foundry tests, including an empirical check of the crash distribution and the 50x cap over 4,000 draws.
- `e2e/`: 9 deterministic clip-engine tests in mock mode (one per reaction rule), and 7 Playwright tests in an iPhone viewport against the live game on Monad Testnet: landing (intro clip + managed wallet funding), auto cash-out win, loss and settle, manual cash-out paid at the tapped multiplier, the Thomas Pesquet clip past 5x, reload keeping the wallet, and going broke then refilling. Every step is checked on-chain.

```bash
cd e2e && pnpm install
BASE_URL=https://jetx-monad.vercel.app npx playwright test
```

## Repo layout

```
contracts/   Foundry: src/JetX.sol, src/JetUSD.sol, tests (incl. distribution check), deploy script
app/         Next.js mobile game: rocket canvas, bet panel, Kaaris clip engine, managed wallet, /api/fund
app/public/kaaris/   38 reaction clips + clips.json (caption, trigger, speaker)
e2e/         Playwright tests against the live game (phone viewport, on-chain assertions)
docs/        Screenshots
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
