import { devices, expect, test, type Page } from "@playwright/test";
import { recordClips, setAuto, waitForClip, waitForQuietCam } from "./game";

/** Animations and reaction rhythm, in mock mode (see clips.spec.ts for the server). */
const MOCK_URL = process.env.MOCK_URL || "http://localhost:3201";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iphone } = devices["iPhone 13"];
test.use({ ...iphone, baseURL: MOCK_URL });

/** Records every FX word shown (kind + text) and every clip start time, relative to the bet. */
async function watch(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __fx: string[]; __flashes: string[]; __starts: { id: string; t: number }[] };
    w.__fx = [];
    w.__flashes = [];
    w.__starts = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll(".fx-slam")) {
        const kind = (el.className.match(/fx-(launch|milestone|win|crash)/) ?? [])[1];
        const item = `${kind}:${el.textContent}`;
        if (kind && !w.__fx.includes(item)) w.__fx.push(item);
      }
      for (const el of document.querySelectorAll(".fx-flash")) {
        const color = (el.className.match(/fx-flash-(red|green|white)/) ?? [])[1];
        if (color && w.__flashes.at(-1) !== color) w.__flashes.push(color);
      }
      const id = document.querySelector(".cam")?.getAttribute("data-clip");
      if (id && w.__starts.at(-1)?.id !== id) w.__starts.push({ id, t: performance.now() });
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-clip", "class"] });
  });
}

async function open(page: Page, crash: number) {
  await recordClips(page);
  await watch(page);
  await page.goto(`/?crash=${crash}`);
  await page.locator(".splash").tap();
  await expect(page.locator(".cta-bet")).toBeEnabled({ timeout: 20_000 });
  await waitForClip(page, ["intro"]);
  await waitForQuietCam(page);
}

const fx = (page: Page) => page.evaluate(() => (window as unknown as { __fx: string[] }).__fx.slice());
const flashes = (page: Page) => page.evaluate(() => (window as unknown as { __flashes: string[] }).__flashes.slice());

test("a long flight keeps Kaaris talking: a new line at least every ~5 s", async ({ page }) => {
  await open(page, 9);
  const betAt = await page.evaluate(() => performance.now());
  await setAuto(page, null);
  await page.locator(".cta-bet").tap();
  await expect(page.locator(".flew")).toBeVisible({ timeout: 60_000 });
  const starts = await page.evaluate(
    (from) => (window as unknown as { __starts: { id: string; t: number }[] }).__starts.filter((s) => s.t >= from && s.id !== "-"),
    betAt,
  );
  // ~22 s of flight: at least 7 lines, and no silence longer than the longest clip (Morsay, 4.7 s) + the rhythm gap.
  expect(starts.length).toBeGreaterThanOrEqual(7);
  const gaps = starts.slice(1).map((s, i) => s.t - starts[i].t);
  expect(Math.max(...gaps)).toBeLessThan(6_500);
});

test("launch, every milestone and the crash each get their animation, with a screen shake on the explosion", async ({ page }) => {
  await open(page, 12);
  await setAuto(page, null);
  await page.locator(".cta-bet").tap();
  await expect(page.locator(".flew")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".phone.shake-hard")).toHaveCount(0, { timeout: 3_000 }); // shake ran and cleared
  const seen = await fx(page);
  const kinds = seen.map((s) => s.split(":")[0]);
  expect(kinds[0]).toBe("launch");
  const milestones = seen.filter((s) => s.startsWith("milestone:"));
  expect(milestones).toEqual(["milestone:🔥 x2", "milestone:⚡ x3", "milestone:🚀 EN ORBITE", "milestone:🌕 LA LUNE"]);
  expect(kinds.at(-1)).toBe("crash");
  await expect(page.locator(".multiplier")).toHaveAttribute("data-tier", "3");
});

test("cashing out flashes green and slams the payout", async ({ page }) => {
  await open(page, 4);
  await setAuto(page, 2);
  await page.locator(".cta-bet").tap();
  await expect(page.locator(".fx-win")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".fx-win")).toContainText("+$20.00");
  expect(await flashes(page)).toContain("green");
});

test("the explosion is loud and visible: crash word, flash and the big boom cam", async ({ page }) => {
  await open(page, 1.6);
  await setAuto(page, null);
  await page.locator(".cta-bet").tap();
  await expect(page.locator(".fx-crash")).toBeVisible({ timeout: 20_000 });
  expect((await flashes(page)).some((c) => c === "red" || c === "white")).toBe(true);
  await expect(page.locator(".cam.cam-boom")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".cam-banner-boom")).toContainText("CRASH");
});
