import { devices, expect, test, type Page } from "@playwright/test";
import { clips, clipsAt, recordClips, setAuto, setBet, waitForClip, waitForQuietCam } from "./game";

/**
 * Reaction engine, against the app in mock mode (no chain), where `?crash=` forces the crash
 * points (a comma list plays them in turn). Lines are drawn at random from per-moment pools, so
 * these tests check the pool each moment draws from, and that the draws actually vary.
 * Start the server with  NEXT_PUBLIC_CHAIN_MODE=mock pnpm dev -p 3201  (in app/).
 */
const MOCK_URL = process.env.MOCK_URL || "http://localhost:3201";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iphone } = devices["iPhone 13"];
test.use({ ...iphone, baseURL: MOCK_URL });

// Mirrors POOLS in app/lib/kaaris.ts.
const P = {
  early: ["jusquau-ciel", "monte-monte", "allez-ca-monte", "cest-bon-ca", "ma-fusee", "oh-la-la", "enorme", "infini", "cest-parti", "celle-la-bonne", "okay"],
  climb: ["monte-bien", "je-vais-monter", "cest-bon-ca", "allez-ca-monte", "monte-monte", "ma-fusee", "oh-la-la", "enorme", "infini", "dinguerie", "magnifique", "celle-la-bonne", "okay", "jcvd"],
  orbit: ["thomas-pesquet", "infini", "laisse-voler"],
  cashTiny: ["eleonore", "ravi", "rigolo", "cest-cela-oui"],
  cashSix: ["je-marrete-a-6", "bim-bam-boom"],
  cashHuge: ["sch-incroyable", "je-suis-riche", "mourir-tranquille", "dinguerie", "magnifique"],
  regret: ["la-haine", "pas-fini"],
  crashBust: ["brogniart-ah", "bravo-nils", "putain", "ravi", "coup-dur", "rigolo", "maillon-faible", "coffe-merde", "au-revoir", "pas-de-bras", "visiteurs-binz"],
  crashSmall: ["bravo-nils", "putain", "ravi", "macron-explosion", "brogniart-ah", "boulette", "coup-dur", "rigolo", "maillon-faible", "coffe-merde", "au-revoir", "houston", "cest-cela-oui", "pas-de-bras"],
  crashBig: ["bravo-nils", "la-haine", "catastrophe", "macron-explosion", "putain", "boulette", "sentence-irrevocable", "monde-de-merde", "etchebest", "visiteurs-binz", "houston"],
  retry: ["on-recommence", "pas-grave", "crash-rembourse", "malentendu"],
  idle: ["laisse-voler", "pas-faux", "tres-simple", "bonne-situation", "cest-cela-oui"],
  broke: ["swipe-up", "la-hess", "malentendu", "pas-de-bras"],
};

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
const inPool = (seq: string[], pool: string[]) => seq.some((c) => pool.includes(c));

test("every flight starts with Kaaris's bet line, and a tiny cash-out gets an ironic line", async ({ page }) => {
  await open(page, 1.5);
  const from = (await clips(page)).length;
  await fly(page, 1.1);
  const seq = await after(page, from);
  expect(seq[0]).toBe("depart");
  const tiny = seq.findIndex((c) => P.cashTiny.includes(c));
  expect(tiny).toBeGreaterThan(0);
  expect(seq.slice(tiny).includes("depart")).toBe(false);
});

test("an instant 1.00x bust draws from the bust lines, in the big boom cam", async ({ page }) => {
  await open(page, 1);
  const from = (await clips(page)).length;
  await fly(page, null);
  await expect.poll(async () => inPool(await after(page, from), P.crashBust), { timeout: 10_000 }).toBe(true);
});

test("small crashes on board draw small-crash lines", async ({ page }) => {
  await open(page, 1.4);
  const from = (await clips(page)).length;
  await fly(page, null);
  await expect.poll(async () => inPool(await after(page, from), P.crashSmall), { timeout: 10_000 }).toBe(true);
  const seq = await after(page, from);
  expect(seq.some((c) => P.crashBig.includes(c) && !P.crashSmall.includes(c))).toBe(false);
});

test("the climb isn't the same every flight: early/climb lines vary across flights", async ({ page }) => {
  test.setTimeout(360_000);
  await open(page, 3);
  const firstLines: string[] = [];
  for (let i = 0; i < 5; i++) {
    const from = (await clips(page)).length;
    await fly(page, null);
    const seq = await after(page, from);
    const climbLines = seq.filter((c) => P.early.includes(c) || P.climb.includes(c));
    expect(climbLines.length).toBeGreaterThanOrEqual(2);
    firstLines.push(climbLines.slice(0, 3).join(","));
    await waitForQuietCam(page, 20_000);
  }
  // Five identical 3x flights must not produce five identical climbs.
  expect(new Set(firstLines).size).toBeGreaterThanOrEqual(3);
});

test("the orbit moment plays a space line between 4.5x and 6x; Thomas Pesquet comes with his banner", async ({ page }) => {
  test.setTimeout(420_000);
  await open(page, 6.5);
  let pesquet = false;
  for (let i = 0; i < 5 && !pesquet; i++) {
    const from = (await clipsAt(page)).length;
    await setAuto(page, null);
    await page.locator(".cta-bet").tap();
    await expect(page.locator(".flew")).toBeVisible({ timeout: 60_000 });
    const orbit = (await clipsAt(page)).slice(from).filter((c) => P.orbit.includes(c.id) && c.m >= 4.4 && c.m <= 6.2);
    expect(orbit.length).toBeGreaterThanOrEqual(1);
    if (orbit.some((c) => c.id === "thomas-pesquet")) pesquet = true;
    await expect(page.locator(".cta-bet")).toBeVisible({ timeout: 30_000 });
    await waitForQuietCam(page, 20_000);
  }
  expect(pesquet).toBe(true);
});

test("a cash-out near 6x favours 'je m'arrête à 6'; a huge one draws huge-win lines", async ({ page }) => {
  await open(page, "7,12");
  let from = (await clips(page)).length;
  await fly(page, 6);
  expect(inPool(await after(page, from), P.cashSix)).toBe(true);
  await waitForQuietCam(page, 20_000);
  from = (await clips(page)).length;
  await fly(page, 10);
  expect(inPool(await after(page, from), P.cashHuge)).toBe(true);
});

test("cashing out early then watching it fly far draws regret lines", async ({ page }) => {
  await open(page, 9);
  const from = (await clips(page)).length;
  await fly(page, 1.5);
  const seq = await after(page, from);
  expect(seq.filter((c) => P.regret.includes(c)).length).toBeGreaterThanOrEqual(1);
});

test("crashing on board past 5x is a big-crash line", async ({ page }) => {
  await open(page, 5.6);
  const from = (await clips(page)).length;
  await fly(page, null);
  await expect.poll(async () => inPool((await after(page, from)).slice(-3), P.crashBig), { timeout: 15_000 }).toBe(true);
});

test("going broke plays a broke line", async ({ page }) => {
  await open(page, 1.2);
  await setBet(page, 1000);
  const from = (await clips(page)).length;
  await fly(page, null);
  await expect(page.locator(".cta-refill")).toBeVisible();
  await expect.poll(async () => inPool(await after(page, from), P.broke), { timeout: 20_000 }).toBe(true);
});

test("idling on the bet screen plays an idle line", async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, 2);
  const from = (await clips(page)).length;
  await expect.poll(async () => inPool(await after(page, from), P.idle), { timeout: 40_000 }).toBe(true);
});
