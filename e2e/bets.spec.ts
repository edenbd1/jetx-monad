import { devices, expect, test, type Page } from "@playwright/test";
import { setAuto, setBet, waitForNextRound } from "./game";

/** Bet limits, in mock mode (see clips.spec.ts for the server): no house maximum, only the balance. */
const MOCK_URL = process.env.MOCK_URL || "http://localhost:3201";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iphone } = devices["iPhone 13"];
test.use({ ...iphone, baseURL: MOCK_URL });

const wallet = async (page: Page) => Number(((await page.locator(".wallet-usd").textContent()) ?? "").replace(/[^\d.]/g, ""));
const betInput = (page: Page) => page.getByRole("textbox", { name: "Bet amount in USDC" });

test("bets go past 1,000 USDC: MAX goes all-in, and only the balance caps a bet", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?crash=3");
  await page.locator(".splash").tap();
  await expect(page.locator(".cta-bet")).toBeEnabled({ timeout: 20_000 });
  expect(await wallet(page)).toBe(1_000);

  // All-in on the whole balance, auto cash-out at 2x: 1,000 → 2,000.
  await page.locator(".chips button", { hasText: "MAX" }).tap();
  await expect(betInput(page)).toHaveValue("1000");
  await setAuto(page, 2);
  await page.locator(".cta-bet").tap();
  await expect(page.locator(".cta-cash")).toBeVisible({ timeout: 20_000 });
  await waitForNextRound(page, 60_000);
  await expect.poll(() => wallet(page), { timeout: 10_000 }).toBe(2_000);

  // 1,500 is a valid bet now; asking for more than the wallet holds is capped at the balance.
  await setBet(page, 1_500);
  await expect(betInput(page)).toHaveValue("1500");
  await setBet(page, 5_000);
  await expect(betInput(page)).toHaveValue("2000");
  await page.locator(".chips button", { hasText: "MAX" }).tap();
  await expect(betInput(page)).toHaveValue("2000");

  await setBet(page, 1_500);
  await page.locator(".cta-bet").tap();
  await expect(page.locator(".cta-cash")).toBeVisible({ timeout: 20_000 });
  await waitForNextRound(page, 60_000);
  await expect.poll(() => wallet(page), { timeout: 10_000 }).toBe(3_500);
});

test("the trophy opens the leaderboard: pilots ranked by USDC, richest first", async ({ page }) => {
  await page.goto("/");
  await page.locator(".splash").tap();
  await expect(page.locator(".cta-bet")).toBeEnabled({ timeout: 20_000 });
  await page.getByRole("button", { name: "Leaderboard" }).tap();
  const board = page.getByRole("dialog", { name: "Leaderboard" });
  await expect(board.locator(".lb-row").first()).toBeVisible({ timeout: 20_000 });
  const amounts = await board.locator(".lb-usd").allTextContents();
  const values = amounts.map((t) => Number(t.replace(/[^\d.]/g, "")));
  expect(values).toEqual([...values].sort((a, b) => b - a));
  await page.getByRole("button", { name: "Close leaderboard" }).tap();
  await expect(board).toBeHidden();
});
