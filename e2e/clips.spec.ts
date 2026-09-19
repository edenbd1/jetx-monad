import { devices, expect, test, type Page } from "@playwright/test";
import { clips, recordClips, setAuto, shownMultiplier, waitForClip, waitForQuietCam } from "./game";

/**
 * Kaaris clip engine, deterministic: runs against the app in mock mode (no chain), where
 * `?crash=` forces every flight's crash point. Start it with
 *   NEXT_PUBLIC_CHAIN_MODE=mock pnpm dev -p 3201   (in app/)
 */
const MOCK_URL = process.env.MOCK_URL || "http://localhost:3201";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iphone } = devices["iPhone 13"];
test.use({ ...iphone, baseURL: MOCK_URL });

/** `crash`: one crash point for every flight, or a comma list played in turn. */
async function open(page: Page, crash: number | string) {
  await recordClips(page);
  await page.goto(`/?crash=${crash}`);
  await page.locator(".splash").tap();
  await expect(page.locator(".cta-bet")).toBeEnabled({ timeout: 20_000 });
  await waitForClip(page, ["intro"]);
  await waitForQuietCam(page);
}

async function fly(page: Page, auto: number | null) {
  await setAuto(page, auto);
  await page.locator(".cta-bet").tap();
  await expect(page.locator(".flew")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".cta-bet")).toBeVisible({ timeout: 30_000 });
}

const after = async (page: Page, from: number) => (await clips(page)).slice(from);

test("bet, launch and a quick cash-out play in order, with no stale launch clip afterwards", async ({ page }) => {
  await open(page, 1.5);
  const from = (await clips(page)).length;
  await fly(page, 1.1);
  const seq = await after(page, from);
  expect(seq[0]).toBe("dix-balles");
  const cashAt = seq.findIndex((c) => ["vas-y-vas-y", "bim-bam-boom", "je-marrete-a-6"].includes(c));
  expect(cashAt).toBeGreaterThan(0);
  expect(seq.slice(cashAt).some((c) => ["cest-parti", "celle-la-bonne"].includes(c))).toBe(false);
});

test("the first crash is 'remboursé', the next ones get 'putain', each followed by a retry line", async ({ page }) => {
  await open(page, 1.4);
  const from = (await clips(page)).length;
  await fly(page, null);
  await waitForClip(page, ["on-recommence", "pas-grave"], 15_000);
  await waitForQuietCam(page);
  await fly(page, null);
  await expect.poll(async () => (await after(page, from)).filter((c) => c === "putain").length, { timeout: 15_000 }).toBe(1);
  const seq = await after(page, from);
  expect(seq.indexOf("crash-rembourse")).toBeGreaterThanOrEqual(0);
  expect(seq.indexOf("crash-rembourse")).toBeLessThan(seq.indexOf("putain"));
  expect(seq.filter((c) => ["on-recommence", "pas-grave"].includes(c)).length).toBeGreaterThanOrEqual(1);
});

test("Thomas Pesquet fires at 5x with its banner, and a cash-out near 6x plays 'je m'arrête à 6'", async ({ page }) => {
  await open(page, 7.5);
  await setAuto(page, null);
  await page.locator(".cta-bet").tap();
  await waitForClip(page, ["thomas-pesquet"], 30_000);
  expect(await shownMultiplier(page)).toBeGreaterThanOrEqual(5);
  await expect(page.locator(".cam-banner")).toContainText("THOMAS PESQUET");
  await expect.poll(() => shownMultiplier(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(5.7);
  await page.locator(".cta-cash").tap();
  await waitForClip(page, ["je-marrete-a-6"], 10_000);
});

test("cashing out early then watching the rocket fly far higher plays 'c'est grave la haine'", async ({ page }) => {
  await open(page, 9);
  const from = (await clips(page)).length;
  await fly(page, 1.5);
  const seq = await after(page, from);
  expect(seq).toContain("la-haine");
});

test("crashing while still on board past 5x plays 'la haine' instead of the small crash line", async ({ page }) => {
  await open(page, "1.3,5.6");
  await fly(page, null); // spends the first-crash line
  await waitForClip(page, ["on-recommence", "pas-grave"], 15_000);
  await waitForQuietCam(page);
  const from = (await clips(page)).length;
  await fly(page, null);
  await expect.poll(async () => await after(page, from), { timeout: 15_000 }).toEqual(expect.arrayContaining(["thomas-pesquet", "la-haine"]));
  const seq = await after(page, from);
  expect(seq).not.toContain("putain");
  expect(seq.indexOf("thomas-pesquet")).toBeLessThan(seq.indexOf("la-haine"));
});
