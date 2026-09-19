import { devices, expect, test, type Page } from "@playwright/test";
import { BROKE_CLIPS, clips, recordClips, setAuto, setBet, shownMultiplier, waitForClip, waitForQuietCam } from "./game";

/**
 * Reaction clip engine, deterministic: runs against the app in mock mode (no chain), where
 * `?crash=` forces the crash points (a comma list plays them in turn). Start it with
 *   NEXT_PUBLIC_CHAIN_MODE=mock pnpm dev -p 3201   (in app/)
 */
const MOCK_URL = process.env.MOCK_URL || "http://localhost:3201";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iphone } = devices["iPhone 13"];
test.use({ ...iphone, baseURL: MOCK_URL });

const SMALL_CRASH = ["putain", "bravo-nils", "macron-explosion"];
const BIG_CRASH = ["la-haine", "catastrophe"];
const HUGE_CASHOUT = ["sch-incroyable", "je-suis-riche"];

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
  await expect(page.locator(".flew")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".cta-bet, .cta-refill").first()).toBeVisible({ timeout: 30_000 });
}

const after = async (page: Page, from: number) => (await clips(page)).slice(from);

test("every flight starts with Kaaris only, and a tiny cash-out gets the ironic Eléonore", async ({ page }) => {
  await open(page, 1.5);
  const from = (await clips(page)).length;
  await fly(page, 1.1);
  const seq = await after(page, from);
  expect(seq[0]).toBe("depart");
  expect(seq).toContain("eleonore");
  expect(seq.slice(seq.indexOf("eleonore")).includes("depart")).toBe(false);
});

test("an instant 1.00x bust is Brogniart's 'Ah !'", async ({ page }) => {
  await open(page, 1);
  const from = (await clips(page)).length;
  await fly(page, null);
  await expect.poll(async () => await after(page, from), { timeout: 10_000 }).toContain("brogniart-ah");
});

test("the first crash is 'remboursé', the next small ones are putain / Nils / Macron, then a retry line", async ({ page }) => {
  await open(page, 1.4);
  const from = (await clips(page)).length;
  await fly(page, null);
  await waitForClip(page, ["on-recommence", "pas-grave"], 15_000);
  await waitForQuietCam(page);
  await fly(page, null);
  await expect.poll(async () => (await after(page, from)).some((c) => SMALL_CRASH.includes(c)), { timeout: 15_000 }).toBe(true);
  const seq = await after(page, from);
  expect(seq.indexOf("crash-rembourse")).toBeGreaterThanOrEqual(0);
  expect(seq.indexOf("crash-rembourse")).toBeLessThan(seq.findIndex((c) => SMALL_CRASH.includes(c)));
});

test("Morsay plays mid-flight, Thomas Pesquet fires at 5x with its banner, and a cash-out near 6x plays 'je m'arrête à 6'", async ({ page }) => {
  await open(page, 7.5);
  const from = (await clips(page)).length;
  await setAuto(page, null);
  await page.locator(".cta-bet").tap();
  await waitForClip(page, ["ma-fusee"], 20_000);
  await waitForClip(page, ["thomas-pesquet"], 30_000);
  expect(await shownMultiplier(page)).toBeGreaterThanOrEqual(5);
  await expect(page.locator(".cam-banner")).toContainText("THOMAS PESQUET");
  await expect.poll(() => shownMultiplier(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(5.7);
  await page.locator(".cta-cash").tap();
  await waitForClip(page, ["je-marrete-a-6"], 10_000);
  const seq = await after(page, from);
  expect(seq.indexOf("ma-fusee")).toBeLessThan(seq.indexOf("thomas-pesquet"));
});

test("a huge cash-out (10x+) gets SCH or 'je suis riche'", async ({ page }) => {
  await open(page, 12);
  const from = (await clips(page)).length;
  await fly(page, 10);
  expect((await after(page, from)).some((c) => HUGE_CASHOUT.includes(c))).toBe(true);
});

test("cashing out early then watching it fly: 'la haine', then Lassalle's 'c'est pas fini ?'", async ({ page }) => {
  await open(page, 9);
  const from = (await clips(page)).length;
  await fly(page, 1.5);
  const seq = await after(page, from);
  expect(seq).toContain("la-haine");
  expect(seq).toContain("pas-fini");
  expect(seq.indexOf("la-haine")).toBeLessThan(seq.indexOf("pas-fini"));
});

test("crashing on board past 5x is a big-crash line (la haine / catastrophe), not a small one", async ({ page }) => {
  await open(page, "1.3,5.6");
  await fly(page, null); // spends the first-crash line
  await waitForClip(page, ["on-recommence", "pas-grave"], 15_000);
  await waitForQuietCam(page);
  const from = (await clips(page)).length;
  await fly(page, null);
  await expect.poll(async () => (await after(page, from)).some((c) => BIG_CRASH.includes(c)), { timeout: 15_000 }).toBe(true);
  const seq = await after(page, from);
  expect(seq.some((c) => SMALL_CRASH.includes(c))).toBe(false);
  expect(seq).toContain("thomas-pesquet");
});

test("going broke plays 'swipe up' or 'c'est la hess'", async ({ page }) => {
  await open(page, 1.2);
  await setBet(page, 1000);
  const from = (await clips(page)).length;
  await fly(page, null);
  await expect(page.locator(".cta-refill")).toBeVisible();
  await expect.poll(async () => (await after(page, from)).some((c) => BROKE_CLIPS.includes(c)), { timeout: 20_000 }).toBe(true);
});

test("idling on the bet screen plays 'laisse voler' or Kaamelott", async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, 2);
  const from = (await clips(page)).length;
  await expect.poll(async () => (await after(page, from)).some((c) => ["laisse-voler", "pas-faux"].includes(c)), { timeout: 40_000 }).toBe(true);
});
