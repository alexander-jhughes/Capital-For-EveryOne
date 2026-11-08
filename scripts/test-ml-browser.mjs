// ML display suggestions, end to end in a real browser against the production build.
// Usage: npx next build, then node scripts/test-ml-browser.mjs [--shots=<dir>]
// Starts `next start -p 3600` unless something already answers there. --shots saves screenshots of the card.
//
// What it proves, with no seeded suggestion anywhere: consent in Display and voice, the explicit actions the
// README documents as the demo path, the "Suggested for you" card on Home in both views, Preview it, Keep it
// (saved to the cfe-prefs cookie), No thanks, Not now, turning suggestions off (deletes the localStorage key),
// the model chunk fetched only after consent, and no personalisation data in what /api/ask receives.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// Playwright is not a project dependency: it is picked up from wherever Node's require can find it (a global install
// or `npm exec --package=playwright`), so this adds nothing to package.json.
const { chromium } = createRequire(import.meta.url)("playwright");

const PORT = 3600;
const BASE = `http://localhost:${PORT}`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const ML_KEY = "cfe-personalisation";
const shotsDir = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length) ?? null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

let failures = 0;
const check = (name, passed, detail = "") => {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed || !detail ? "" : `\n      ${detail}`}`);
};

const alive = async () => {
  try {
    await fetch(`${BASE}/account`);
    return true;
  } catch {
    return false;
  }
};
let server = null;
if (!(await alive())) {
  server = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "ignore", detached: true });
  for (let attempt = 0; !(await alive()); attempt += 1) {
    if (attempt > 150) throw new Error(`next start did not answer on ${PORT}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
const problems = [];

/** The trained model travels as a lazily loaded JS chunk. This recognises it by its content, not its (hashed) name. */
const looksLikeModel = (text) => text.length > 100_000 && text.includes("20261107") && text.includes("baseRate") && text.includes("trainedOn");

async function open({ mode, viewport = PHONE, prefs } = {}) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([
    { name: "cfe-mode", value: mode, domain: "localhost", path: "/" },
    ...(prefs ? [{ name: "cfe-prefs", value: encodeURIComponent(JSON.stringify(prefs)), domain: "localhost", path: "/" }] : []),
  ]);
  const page = await context.newPage();
  page.modelChunks = 0;
  page.on("response", async (res) => {
    if (!/\.js(\?|$)/.test(res.url())) return;
    try {
      if (looksLikeModel(await res.text())) page.modelChunks += 1;
    } catch {}
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("404")) problems.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
  return page;
}

const settle = (page) => page.waitForTimeout(300);
const mlState = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), ML_KEY);
const prefsCookie = async (page) => {
  const c = (await page.context().cookies()).find((x) => x.name === "cfe-prefs");
  return c ? JSON.parse(decodeURIComponent(c.value)) : null;
};
const card = (page) => page.locator("section", { has: page.getByRole("heading", { name: "Suggested for you" }) });
const widgets = (page) => page.locator("[data-widget]").count();
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** Home has rendered its sections (a calmer layout may drop Spend Pause, so wait for any section, not a particular one). */
const homeReady = async (page) => {
  await page.locator("[data-widget]").first().waitFor();
  await settle(page);
};
const goHome = async (page) => {
  await page.goto(`${BASE}/account`);
  await homeReady(page);
};
const goSettings = async (page) => {
  await page.goto(`${BASE}/account/settings`);
  await page.getByRole("heading", { name: "Suggestions from Dial" }).waitFor();
};
/** The Home card only shows once Make it yours is done or skipped, so skip it the way a person would. */
const skipMakeItYours = async (page) => {
  await goHome(page);
  const invite = page.locator("section", { has: page.getByRole("heading", { name: "Make it yours" }) });
  await invite.getByRole("button", { name: "Not now" }).click();
  await invite.waitFor({ state: "detached" });
};
/** The settings radios are visually hidden inside their labels, so tap the label like a person would. */
const pick = async (page, label) => {
  await page.getByText(label, { exact: true }).click();
  await settle(page);
};
const suggestions = (page, on) => pick(page, on ? "On" : "Off");
const hideSection = async (page, label) => {
  await page.getByRole("checkbox", { name: label }).uncheck();
  await settle(page);
};
const openDialAndClose = async (page) => {
  await page.getByRole("button", { name: /^Dial/ }).click();
  const dial = page.locator("dialog.voice-mode");
  await dial.waitFor();
  await dial.getByRole("button", { name: "Close Dial" }).click();
  await dial.waitFor({ state: "hidden" });
};
const shot = async (page, name) => {
  if (!shotsDir) return;
  await card(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
};

try {
  console.log("\nA. Detailed view: consent, hide a section, card, Preview it, Keep it, saved, not offered again");
  {
    const page = await open({ mode: "complex" });
    await skipMakeItYours(page);
    await goSettings(page);
    check("no model chunk is fetched before consent", page.modelChunks === 0);
    check("nothing is stored before consent", (await mlState(page)) === null);
    await suggestions(page, true);
    await page.waitForFunction(() => document.querySelector('[aria-label="Main"]') !== null); // page settled
    for (let i = 0; i < 20 && page.modelChunks === 0; i++) await page.waitForTimeout(250);
    check("the model chunk is fetched only after consent", page.modelChunks >= 1);
    check("consent is stored on this device", (await mlState(page))?.consent === "granted");
    await hideSection(page, "Recent transactions");
    check("hiding a section counts as asking for less on screen", (await mlState(page))?.signals?.lessOnScreen === 1, JSON.stringify(await mlState(page)));
    await goHome(page);
    await card(page).waitFor();
    const text = await card(page).innerText();
    check("Home shows Suggested for you: a calmer home screen", text.includes("A calmer home screen"));
    check("the plain reason is visible without opening anything", text.includes("You hid a section on your home screen, so Dial suggests a calmer home screen that shows only the first three sections."));
    check("the detailed reasons are behind Why am I seeing this?", (await card(page).locator("details[open]").count()) === 0 && text.includes("Why am I seeing this?"));
    check("the card says it is on this device and changes nothing by itself", text.includes("on this device") && text.includes("Nothing changes unless you preview it"));
    // 11 Detailed sections by default since the product workstream's command centre (lib/preferences/schema.ts), minus the one hidden above.
    check("Detailed Home shows 10 sections before the preview", (await widgets(page)) === 10, String(await widgets(page)));
    check("no sideways scroll", await fits(page));
    await shot(page, "detailed-100");
    await card(page).getByRole("button", { name: "Preview it" }).click();
    await page.getByRole("region", { name: "Style preview" }).waitFor();
    await settle(page);
    check("Preview it shows the preview bar", (await page.getByRole("region", { name: "Style preview" }).innerText()).includes("Previewing A calmer home screen"));
    check("the preview shows only the first three sections", (await widgets(page)) === 3, String(await widgets(page)));
    check("the card hides while previewing", (await card(page).count()) === 0);
    check("a preview saves nothing", (await prefsCookie(page))?.layout?.density !== "calm");
    await page.getByRole("button", { name: "Keep it" }).click();
    await page.getByRole("region", { name: "Style preview" }).waitFor({ state: "detached" });
    await settle(page);
    const saved = await prefsCookie(page);
    check("Keep it saves a calmer home screen to the cfe-prefs cookie", saved?.layout?.density === "calm", JSON.stringify(saved?.layout));
    check("Keep it is remembered as accepted", typeof (await mlState(page))?.accepted?.calmLayout === "string");
    check("the card is gone after Keep it", (await card(page).count()) === 0);
    await page.reload();
    await homeReady(page);
    check("after a reload the calmer layout is still on (3 sections) and the suggestion does not come back", (await widgets(page)) === 3 && (await card(page).count()) === 0);

    const bodies = [];
    await page.route("**/api/ask", async (route) => {
      bodies.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answer: "Noted.", evidenceIds: [], source: "template" }) });
    });
    await page.getByRole("button", { name: /^Dial/ }).click();
    const dial = page.locator("dialog.voice-mode");
    await dial.waitFor();
    await dial.getByRole("textbox").fill("How much do I owe?");
    await dial.getByRole("textbox").press("Enter");
    await dial.getByText("Noted.").first().waitFor({ timeout: 10000 });
    const sent = bodies.at(-1) ?? "";
    check("the question reached /api/ask", sent.includes("How much do I owe?"));
    check("the /api/ask body carries no personalisation data", !/personalis|consent|signal|lessOnScreen|voiceSessions|textLarger|calmLayout|fingerprint|accepted|rejected/i.test(sent), sent.slice(0, 300));
    await dial.getByRole("button", { name: "Close Dial" }).click();
    await page.context().close();
  }

  console.log("\nB. Simple view: bigger buttons and three Dial taps, No thanks, Not now, turning suggestions off");
  {
    const page = await open({ mode: "simple" });
    await skipMakeItYours(page);
    await goSettings(page);
    await suggestions(page, true);
    await pick(page, "Bigger");
    for (let i = 0; i < 3; i++) await openDialAndClose(page);
    check("opening Dial three times is counted as three, and bigger buttons added no count", JSON.stringify((await mlState(page))?.signals) === JSON.stringify({ voiceSessions: 3 }), JSON.stringify(await mlState(page)));
    await goHome(page);
    await card(page).waitFor();
    let text = await card(page).innerText();
    check("Simple Home shows Suggested for you: Talking to Dial first", text.includes("Talking to Dial first"));
    check("the plain reason names the three Dial taps", text.includes("You've talked to Dial 3 times, so Dial suggests a Talk to Dial button at the top of your home screen."));
    check("no sideways scroll", await fits(page));
    await shot(page, "simple-100");
    await card(page).getByRole("button", { name: "Preview it" }).click();
    await page.getByRole("region", { name: "Style preview" }).waitFor();
    await settle(page);
    check("the preview adds the Talk to Dial button", (await page.getByRole("button", { name: "Talk to Dial" }).count()) >= 1);
    await page.getByRole("button", { name: "Go back" }).click();
    await page.getByRole("region", { name: "Style preview" }).waitFor({ state: "detached" });
    await settle(page);
    check("Go back puts it back and counts as a no", (await page.getByRole("button", { name: "Talk to Dial" }).count()) === 0 && (await mlState(page))?.rejected?.voiceFirst?.count === 1);
    check("after a no the suggestion is gone", (await card(page).count()) === 0);
    check("a no saves nothing", ((await prefsCookie(page))?.voiceFirst ?? false) === false);

    // A different explicit action brings a different suggestion, which can be declined outright.
    await goSettings(page);
    await hideSection(page, "Dial noticed");
    await goHome(page);
    await card(page).waitFor();
    text = await card(page).innerText();
    check("hiding a section in Simple view brings the calmer home screen suggestion", text.includes("A calmer home screen") && text.includes("You hid a section on your home screen"));
    await card(page).getByRole("button", { name: "No thanks" }).click();
    await settle(page);
    check("No thanks records a rejection and removes the card", (await mlState(page))?.rejected?.calmLayout?.count === 1 && (await card(page).count()) === 0);
    await page.reload();
    await homeReady(page);
    check("the rejected suggestion does not come back after a reload", (await card(page).count()) === 0);

    // Reset suggestions forgets the counts and the noes. With only kept settings left (one hidden section, bigger
    // buttons) the model is not confident enough, so no card; one more explicit action earns it back, and Not now holds it.
    await goSettings(page);
    await page.getByRole("button", { name: "Reset suggestions" }).click();
    await settle(page);
    check("Reset suggestions forgets counts and answers but keeps consent", JSON.stringify(await mlState(page)) === JSON.stringify({ version: 1, consent: "granted", signals: {}, rejected: {}, ignored: {}, accepted: {} }), JSON.stringify(await mlState(page)));
    await goHome(page);
    check("after the reset, saved settings alone do not earn a suggestion", (await card(page).count()) === 0);
    await goSettings(page);
    await hideSection(page, "Spend Pause");
    await goHome(page);
    await card(page).waitFor();
    check("hiding a second section brings the calmer suggestion back, with the new count", (await card(page).innerText()).includes("You hid 2 sections on your home screen, so Dial suggests"));
    await card(page).getByRole("button", { name: "Not now" }).click();
    await settle(page);
    check("Not now holds the suggestion and removes the card", typeof (await mlState(page))?.ignored?.calmLayout === "string" && (await card(page).count()) === 0);

    await goSettings(page);
    await suggestions(page, false);
    check("turning suggestions off deletes the stored ML state", (await mlState(page)) === null);
    // Bigger buttons were kept for this visit, not saved, so they live in the session, not the cookie.
    check("turning suggestions off leaves display settings alone", (await page.evaluate(() => document.documentElement.dataset.targets)) === "large");
    await goHome(page);
    check("no card with suggestions off", (await card(page).count()) === 0);
    await page.context().close();
  }

  console.log("\nC. Without consent, explicit actions are not counted and nothing is fetched");
  {
    const page = await open({ mode: "complex" });
    await skipMakeItYours(page);
    await goSettings(page);
    await hideSection(page, "Recent transactions");
    await openDialAndClose(page);
    await goHome(page);
    check("no card, no stored state, no model chunk", (await card(page).count()) === 0 && (await mlState(page)) === null && page.modelChunks === 0);
    await page.context().close();
  }

  console.log("\nD. The same demo path at 150% text, both views");
  for (const mode of ["complex", "simple"]) {
    const page = await open({ mode });
    await skipMakeItYours(page);
    await goSettings(page);
    await suggestions(page, true);
    await pick(page, "150%");
    await hideSection(page, mode === "complex" ? "Recent transactions" : "Dial noticed");
    await goHome(page);
    await card(page).waitFor();
    const text = await card(page).innerText();
    check(`${mode} at 150%: the calmer home screen card appears with its reason`, text.includes("A calmer home screen") && text.includes("You hid a section on your home screen, so Dial suggests"));
    check(`${mode} at 150%: text size really applied and no sideways scroll`, (await page.evaluate(() => document.documentElement.dataset.text)) === "150" && (await fits(page)));
    await shot(page, `${mode === "complex" ? "detailed" : "simple"}-150`);
    await page.context().close();
  }

  console.log("\nE. Desktop layout");
  {
    const page = await open({ mode: "complex", viewport: DESKTOP });
    await skipMakeItYours(page);
    await goSettings(page);
    await suggestions(page, true);
    await hideSection(page, "Recent transactions");
    await goHome(page);
    await card(page).waitFor();
    check("desktop Detailed shows the card", (await card(page).innerText()).includes("Suggested for you"));
    await shot(page, "detailed-desktop-100");
    await page.context().close();
  }

  check("no console or page errors anywhere", problems.length === 0, [...new Set(problems)].slice(0, 4).join(" | "));
} catch (error) {
  failures += 1;
  console.log(`FAIL  the run stopped early: ${String(error).split("\n").slice(0, 12).join(" ").slice(0, 1200)}`);
} finally {
  await browser.close();
  if (server?.pid) process.kill(-server.pid);
}

console.log(`\n${failures === 0 ? "All passed" : `${failures} failed`}`);
process.exit(failures > 0 ? 1 : 0);
