import { devices, expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Address } from "viem";
import { activeRound, lastRoundOf, mon, round, Status, usdc } from "./chain";
import {
  CASHOUT_CLIPS,
  clips,
  CRASH_CLIPS,
  enter,
  launch,
  recordClips,
  RETRY_CLIPS,
  setAuto,
  setBet,
  shownMultiplier,
  waitForClip,
  waitForQuietCam,
  waitForNextRound,
} from "./game";

// One phone, one managed wallet for the whole run: every test builds on the previous one.
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let player: Address;

test.beforeAll(async ({ browser }) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { defaultBrowserType, ...iphone } = devices["iPhone 13"];
  context = await browser.newContext({ ...iphone, baseURL: process.env.BASE_URL || "http://localhost:3200" });
  page = await context.newPage();
  await recordClips(page);
});

test.afterAll(async () => {
  await context.close();
});

const bet = () => page.locator(".cta-bet");
const cash = () => page.locator(".cta-cash");
const txRow = (step: 1 | 2) => page.locator(".tx").filter({ hasText: `TX ${step}` });

test("landing: the splash unlocks audio, Kaaris intro plays, the managed wallet gets gas and USDC", async () => {
  player = await enter(page);
  await waitForClip(page, ["intro"], 15_000);
  expect(await usdc(player)).toBeGreaterThanOrEqual(1_000);
  expect(await mon(player)).toBeGreaterThanOrEqual(0.1);
  await expect(bet()).toBeEnabled();
  await expect(page.locator(".splash")).toHaveCount(0);
});

test("win: auto cash-out at 1.10x is two on-chain txs and pays bet x 1.10", async () => {
  const before = await usdc(player);
  await setBet(page, 5);
  await setAuto(page, 1.1);
  // A bet placed while the intro still plays is superseded by the launch clip; bet like a player would.
  await waitForQuietCam(page);
  await bet().tap();
  await waitForClip(page, ["dix-balles"], 10_000);
  // The launch line may be superseded by the 1.10x cash-out a second later (order: clips.spec.ts).
  await expect(txRow(1)).toContainText(/\d+\s?ms/, { timeout: 20_000 });
  await waitForNextRound(page);

  const r = (await lastRoundOf(player))!;
  expect(r.bet).toBe(BigInt(5e6));
  await expect(txRow(2)).toBeVisible();
  if (r.crash >= 110) {
    expect(r.status).toBe(Status.CashedOut);
    expect(r.cashedAt).toBe(110);
    expect(await usdc(player)).toBeCloseTo(before - 5 + 5.5, 6);
    await waitForClip(page, CASHOUT_CLIPS);
  } else {
    // 12% of flights bust below 1.10x: then it's a clean loss.
    expect(r.status).toBe(Status.Crashed);
    expect(await usdc(player)).toBeCloseTo(before - 5, 6);
    await waitForClip(page, CRASH_CLIPS);
  }
});

test("loss: riding to the crash settles on-chain and Kaaris reacts, then the history shows it", async () => {
  const before = await usdc(player);
  await setBet(page, 1);
  await setAuto(page, null);
  const seen = (await clips(page)).length;
  await bet().tap();
  await expect(page.locator(".flew")).toBeVisible({ timeout: 150_000 });
  await waitForNextRound(page);

  const r = (await lastRoundOf(player))!;
  expect(r.status).toBe(Status.Crashed);
  expect(r.cashedAt).toBe(0);
  expect(await usdc(player)).toBeCloseTo(before - 1, 6);
  await expect(txRow(2)).toContainText(/settle|crash/i);

  await expect.poll(async () => (await clips(page)).slice(seen).some((c) => CRASH_CLIPS.includes(c))).toBe(true);
  await expect.poll(async () => (await clips(page)).slice(seen).some((c) => RETRY_CLIPS.includes(c)), { timeout: 15_000 }).toBe(true);
  await expect(page.locator('[aria-label="Previous flights"] > *').first()).toContainText((r.crash / 100).toFixed(2));
});

test("manual cash-out mid-flight pays exactly bet x the multiplier at the tap", async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await usdc(player);
    await setBet(page, 2);
    await setAuto(page, null);
    if ((await launch(page)) === "busted") {
      await waitForNextRound(page);
      continue;
    }
    const id = await activeRound(player);
    const flight = await round(id);
    if (flight.crash < 145) {
      await waitForNextRound(page);
      continue;
    }
    await expect.poll(() => shownMultiplier(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1.3);
    const tapped = await shownMultiplier(page);
    await cash().tap();
    await expect(page.locator(".win-chip")).toBeVisible();
    await waitForNextRound(page);

    const r = await round(id);
    expect(r.status).toBe(Status.CashedOut);
    expect(r.cashedAt).toBeGreaterThanOrEqual(130);
    expect(r.cashedAt).toBeLessThanOrEqual(r.crash);
    expect(Math.abs(r.cashedAt / 100 - tapped)).toBeLessThan(0.1);
    expect(await usdc(player)).toBeCloseTo(before - 2 + (2 * r.cashedAt) / 100, 6);
    return;
  }
  test.skip(true, "no flight above 1.45x in 5 tries");
});

test("Thomas Pesquet: past 5x the big ref plays with its banner, and cashing out banks it", async () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const before = await usdc(player);
    await setBet(page, 1);
    await setAuto(page, null);
    if ((await launch(page)) === "busted") {
      await waitForNextRound(page);
      continue;
    }
    const id = await activeRound(player);
    if ((await round(id)).crash < 540) {
      await waitForNextRound(page);
      continue;
    }
    await waitForClip(page, ["thomas-pesquet"], 40_000);
    await expect(page.locator(".cam-banner")).toContainText("THOMAS PESQUET");
    expect(await shownMultiplier(page)).toBeGreaterThanOrEqual(5);
    await cash().tap();
    await waitForNextRound(page);
    const r = await round(id);
    expect(r.status).toBe(Status.CashedOut);
    expect(r.cashedAt).toBeGreaterThanOrEqual(500);
    expect(await usdc(player)).toBeCloseTo(before - 1 + r.cashedAt / 100, 6);
    return;
  }
  test.skip(true, "no 5.4x flight in 12 tries");
});

test("reloading keeps the same managed wallet, topping up gas only when it runs low", async () => {
  const monBefore = await mon(player);
  const usdcBefore = await usdc(player);
  await page.reload();
  await page.locator(".splash").tap();
  await expect(page.locator(".wallet-usd")).toHaveText(/\$/, { timeout: 30_000 });
  const key = await page.evaluate(() => localStorage.getItem("jetx-wallet-v1"));
  expect(key).toBeTruthy();
  const { addressOfKey } = await import("./chain");
  expect(addressOfKey(key as `0x${string}`)).toBe(player);
  expect(await usdc(player)).toBeCloseTo(usdcBefore, 6);
  // The house refills 0.1 MON below 0.04 MON (a flight costs ~0.025), never above.
  if (monBefore >= 0.04) expect(await mon(player)).toBeLessThanOrEqual(monBefore + 1e-9);
  else expect(await mon(player)).toBeGreaterThanOrEqual(0.1);
});

test("broke: losing everything shows REFILL, which tops the wallet back up to 1,000 USDC", async () => {
  for (let i = 0; i < 3 && (await usdc(player)) >= 0.1; i++) {
    const all = Math.min(1_000, Math.floor((await usdc(player)) * 100) / 100);
    await setBet(page, all);
    await setAuto(page, null);
    await bet().tap();
    await expect(page.locator(".flew")).toBeVisible({ timeout: 150_000 });
    await expect(page.locator(".cta-bet, .cta-refill").first()).toBeVisible({ timeout: 60_000 });
  }
  expect(await usdc(player)).toBeLessThan(0.1);
  await expect(page.locator(".cta-refill")).toBeVisible();
  await waitForClip(page, ["swipe-up"], 30_000);
  await page.locator(".cta-refill").tap();
  await expect(bet()).toBeVisible({ timeout: 60_000 });
  expect(await usdc(player)).toBeGreaterThanOrEqual(1_000);
});
