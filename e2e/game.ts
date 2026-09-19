import type { Page } from "@playwright/test";
import type { Address, Hex } from "viem";
import { expect } from "@playwright/test";
import { addressOfKey } from "./chain";

export const CASHOUT_CLIPS = ["je-marrete-a-6", "bim-bam-boom", "vas-y-vas-y", "eleonore", "sch-incroyable", "je-suis-riche"];
export const CRASH_CLIPS = ["putain", "bravo-nils", "macron-explosion", "la-haine", "catastrophe", "crash-rembourse", "brogniart-ah"];
export const BROKE_CLIPS = ["swipe-up", "la-hess"];
export const RETRY_CLIPS = ["on-recommence", "pas-grave"];

/** Records every Kaaris clip the cam shows, in order, into window.__clips. */
export async function recordClips(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __clips: string[] };
    w.__clips = [];
    new MutationObserver(() => {
      const id = document.querySelector(".cam")?.getAttribute("data-clip");
      if (id && w.__clips.at(-1) !== id) w.__clips.push(id);
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-clip"] });
  });
}

export const clips = (page: Page) => page.evaluate(() => (window as unknown as { __clips: string[] }).__clips.slice());

export async function waitForClip(page: Page, ids: string[], timeout = 30_000) {
  await expect.poll(async () => (await clips(page)).some((c) => ids.includes(c)), { timeout }).toBe(true);
}

/** Taps the splash (unlocks audio) and waits for the managed wallet to be funded. */
export async function enter(page: Page): Promise<Address> {
  await page.goto("/");
  await page.locator(".splash").tap();
  await expect(page.locator(".wallet-usd")).toHaveText(/\$\s?[1-9]/, { timeout: 60_000 });
  const key = (await page.evaluate(() => localStorage.getItem("jetx-wallet-v1"))) as Hex;
  return addressOfKey(key);
}

export async function setBet(page: Page, amount: number) {
  const input = page.getByRole("textbox", { name: "Bet amount in USDC" });
  await input.fill(String(amount));
  await input.blur();
}

export async function setAuto(page: Page, multiplier: number | null) {
  const toggle = page.locator(".auto .switch");
  const on = (await toggle.getAttribute("aria-pressed")) === "true";
  if ((multiplier !== null) !== on) await toggle.tap();
  if (multiplier !== null) {
    const input = page.getByRole("textbox", { name: "Auto cash-out multiplier" });
    await input.fill(multiplier.toFixed(2));
    await input.blur();
  }
}

/** Current multiplier shown in the sky (written every frame). */
export async function shownMultiplier(page: Page) {
  const text = (await page.locator(".multiplier").textContent()) ?? "";
  return Number(text.replace(/[^\d.]/g, "")) || 0;
}

/** Waits until the round is over and the BET button is back. */
export async function waitForNextRound(page: Page, timeout = 150_000) {
  await expect(page.locator(".cta-bet")).toBeVisible({ timeout });
}

/** Waits until Kaaris is done talking (the cam bubble is hidden). */
export async function waitForQuietCam(page: Page, timeout = 15_000) {
  await expect(page.locator(".cam")).not.toHaveAttribute("data-on", /.*/, { timeout });
}

/** Taps BET and waits for the jet to fly, or for an instant 1.00x bust (~4% of flights). */
export async function launch(page: Page): Promise<"flying" | "busted"> {
  await page.locator(".cta-bet").tap();
  const cash = page.locator(".cta-cash");
  const flew = page.locator(".flew");
  await expect(cash.or(flew).first()).toBeVisible({ timeout: 20_000 });
  return (await cash.isVisible()) ? "flying" : "busted";
}
