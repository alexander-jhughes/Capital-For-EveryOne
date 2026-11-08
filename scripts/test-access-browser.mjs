// Accessibility engine, end to end in a real browser with the real on-device model: Dial understands a described need,
// previews it, keeps it, undoes it, asks instead of guessing, refuses looks it can't do, keeps the bill on a calmer
// Home, and Settings lists every change with Turn off and Pause. Checked with axe, at 200% text for horizontal
// overflow, in dark mode, with the keyboard, and for console errors.
// Usage: npm run build && SESSION_SECRET=<32+ chars> npx next start -p 3100, then
//   BASE_URL=http://localhost:3100 npm run test:access
// Screenshots go to docs/screenshots/access/.

import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";

/** A package from this project, or from `npm exec --package=...`, which puts its packages' .bin folder on PATH. */
function load(name, resolveOnly = false) {
  const bases = [import.meta.url, ...(process.env.PATH ?? "").split(delimiter).filter((d) => /node_modules[\\/]\.bin$/.test(d)).map((d) => join(d, "..", "x.js"))];
  for (const base of bases) {
    try {
      const req = createRequire(base);
      return resolveOnly ? req.resolve(name) : req(name);
    } catch {}
  }
  return null;
}
const { chromium } = load("playwright") ?? load("playwright-core");
const axePath = load("axe-core", true);
const axeSource = axePath ? readFileSync(axePath, "utf8") : null;

const BASE = (process.env.BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const HOST = new URL(BASE).hostname;
const SHOTS = "docs/screenshots/access";
mkdirSync(SHOTS, { recursive: true });
const PHONE = { width: 390, height: 844 };

let failures = 0;
const check = (name, passed, detail = "") => {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed || !detail ? "" : `\n      ${detail}`}`);
};

const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "chrome" }));
const problems = [];

async function open({ mode = "complex", viewport = PHONE, prefs, colorScheme } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  await context.addCookies([
    { name: "cfe-mode", value: mode, domain: HOST, path: "/" },
    ...(prefs ? [{ name: "cfe-prefs", value: encodeURIComponent(JSON.stringify(prefs)), domain: HOST, path: "/" }] : []),
  ]);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) problems.push(`${page.url()}: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => problems.push(`${page.url()}: ${String(e).slice(0, 200)}`));
  return page;
}
async function go(page, path) {
  await page.goto(`${BASE}${path}`);
  await page.waitForFunction(() => !!window.next?.router);
  await page.waitForTimeout(200);
}
const attr = (page, name) => page.evaluate((n) => document.documentElement.getAttribute(n), name);
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const prefsCookie = async (page) => {
  const c = (await page.context().cookies()).find((x) => x.name === "cfe-prefs");
  return c ? JSON.parse(decodeURIComponent(c.value)) : null;
};
async function axe(page, label) {
  if (!axeSource) return console.log(`SKIP  axe: ${label} (axe-core not found)`);
  await page.waitForTimeout(400);
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.addScriptTag({ content: axeSource });
  const found = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] });
    return result.violations.map((v) => `${v.id}: ${v.nodes[0].html.slice(0, 100)} ${v.nodes[0].failureSummary?.replace(/\s+/g, " ").slice(0, 200)}`);
  });
  check(`axe: ${label}`, found.length === 0, found.join(" ; "));
}

// ─── Dial ────────────────────────────────────────────────────────────────────────────────────────────────────────
const dialog = (page) => page.locator("dialog[open]");
async function openDial(page) {
  await page.locator('nav[aria-label="Main"] button').first().click();
  await dialog(page).waitFor();
}
/** Types a request and waits for the reply to finish. Returns the reply's text. */
async function say(page, text) {
  await page.getByLabel("Type to Dial").fill(text);
  await page.getByLabel("Type to Dial").press("Enter");
  await page.waitForTimeout(300);
  // The turn is done when its loading pulse has gone; then wait out the preview's reveal (~750 ms per change).
  const done = await page.waitForFunction(() => !document.querySelector("dialog[open] .animate-pulse"), null, { timeout: 15000 }).then(() => true, () => false);
  if (!done) console.log(`      (Dial was still working on "${text}" after 15 s)`);
  await page.waitForTimeout(2500);
  return dialog(page).innerText();
}
/** The on-device model loads when Dial opens; the first sentence may arrive before it's ready, so try a few times. */
async function sayUntil(page, text, done, tries = 6) {
  let reply = "";
  for (let i = 0; i < tries; i++) {
    reply = await say(page, text);
    if (done(reply)) return reply;
    await page.waitForTimeout(3000);
  }
  return reply;
}
const keep = (page) => dialog(page).getByRole("button", { name: "Keep it", exact: true }).click();

// ─── 1. A described need, previewed, kept, then "I changed my mind" ─────────────────────────────────────────────
{
  const page = await open();
  await go(page, "/account");
  await openDial(page);
  const reply = await sayUntil(page, "I can't use a mouse", (r) => r.includes("Getting around the app is hard"));
  check("Dial understands 'I can't use a mouse' by meaning (on the device) and says what it heard", reply.includes("Getting around the app is hard"), reply.slice(-400));
  check("each change is listed with its reason", reply.includes("thick outline") && reply.includes("Your bill always stays"));
  check("the change is previewed straight away, before anything is kept", (await attr(page, "data-focus-ring")) === "strong");
  check("nothing is saved by a preview", (await prefsCookie(page))?.focusRing !== "strong");
  await page.screenshot({ path: `${SHOTS}/01-adapt-preview.png` });
  await keep(page);
  await page.waitForTimeout(600);
  check("Keep it keeps the change and saves it (scope: always)", (await attr(page, "data-focus-ring")) === "strong" && (await prefsCookie(page))?.focusRing === "strong");

  const undone = await say(page, "I changed my mind");
  check("'I changed my mind' undoes it", (await attr(page, "data-focus-ring")) === "standard", undone.slice(-200));

  // ─── 2. Asking instead of guessing, and refusing what it can't do ───────────────────────────────────────────
  const asked = await say(page, "make the text bigger and smaller");
  check("a contradiction gets a question, not a change", asked.includes("Do you want it bigger or smaller?") && (await attr(page, "data-text")) === "100");
  const vague = await say(page, "make it better");
  check("a vague request gets real options", vague.includes("What would help?"));
  const purple = await say(page, "make the background purple");
  check("a look Dial doesn't offer changes nothing and isn't read as colour blindness", !purple.slice(-300).includes("I heard") && (await attr(page, "data-colours")) === "standard" && (await attr(page, "data-contrast")) === "standard", purple.slice(-300));
  const pause = await say(page, "turn off Spend Pause");
  check(
    "'turn off Spend Pause' doesn't hide or change Spend Pause; it answers and points to the Spend Pause screen",
    /can't turn this off for you|already off/.test(pause) && pause.includes("Open Spend Pause") && !pause.includes("Keep it"),
    pause.slice(-200),
  );

  // ─── 3. Several adaptations: the important things stand out, and a calmer Home keeps the bill ──────────────
  const stand = await sayUntil(page, "Make the important information stand out", (r) => r.includes("important things to stand out"));
  check("'make the important information stand out' is understood", stand.includes("important things to stand out"), stand.slice(-300));
  await keep(page);
  const calm = await say(page, "This screen is overwhelming");
  check("'this screen is overwhelming' previews a calmer home screen", /show less on the home screen/i.test(calm), calm.slice(-300));
  await keep(page);
  await dialog(page).getByRole("button", { name: "Close Dial" }).click();
  await page.waitForTimeout(500);
  const sections = await page.locator("main section[aria-labelledby^='w-']").evaluateAll((s) => s.map((x) => x.getAttribute("aria-labelledby")));
  check("Home is calmer and the bill is first and kept", sections[0] === "w-bill" && sections.length <= 4, JSON.stringify(sections));
  check("Spend Pause is still one tap away in the main navigation", (await page.locator('nav[aria-label="Main"] a[href="/account/spend-pause"]').count()) === 1);
  check("stronger contrast is on", (await attr(page, "data-contrast")) === "high");
  await page.screenshot({ path: `${SHOTS}/02-calm-home-bill-first.png`, fullPage: true });

  // ─── 4. Settings: your changes, Turn off, Pause ─────────────────────────────────────────────────────────────
  await go(page, "/account/settings");
  const yours = page.locator("section[aria-labelledby='s-yours']");
  const listed = await yours.innerText();
  check("Settings lists the changes Dial made, in plain words", /Use stronger contrast/.test(listed) && /Put your bill and next payment at the top/i.test(listed) && /Show less on the home screen/i.test(listed), listed);
  await page.screenshot({ path: `${SHOTS}/03-your-changes.png`, fullPage: true });
  await yours.getByRole("button", { name: "Pause my changes for this visit" }).click();
  check("Pause shows the standard look without losing anything", (await attr(page, "data-contrast")) === "standard" && (await prefsCookie(page))?.contrast === "high");
  await yours.getByRole("button", { name: "Turn my changes back on" }).click();
  check("Turn my changes back on restores them", (await attr(page, "data-contrast")) === "high");
  await yours.getByRole("button", { name: /^Turn off\s*:\s*Use stronger contrast$/ }).click();
  check("Turn off removes just that change", (await attr(page, "data-contrast")) === "standard" && /Show less on the home screen/i.test(await yours.innerText()));
  await axe(page, "Settings with changes listed");
  await page.context().close();
}

// ─── 5. Keyboard: the thick focus ring is real ──────────────────────────────────────────────────────────────────
{
  const page = await open({ prefs: { focusRing: "strong" } });
  await go(page, "/account");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineWidth);
  check("with the thick focus ring, the focused control has a 5px outline", ring === "5px", ring);
  await page.screenshot({ path: `${SHOTS}/04-focus-ring.png` });
  await page.context().close();
}

// ─── 6. 200% text, dark mode, Simple view: no sideways scrolling, axe clean ─────────────────────────────────────
{
  const all = { textSize: 200, contrast: "high", spacing: "roomy", targets: "large", focusRing: "strong", layout: { pinned: ["bill"], shown: [], hidden: [], emphasis: "bill", density: "calm" } };
  for (const [label, opts] of [
    ["Detailed, 200% text and every adaptation", { prefs: all }],
    ["Simple, 200% text, dark", { mode: "simple", prefs: { ...all, theme: "dark" }, colorScheme: "dark" }],
  ]) {
    const page = await open(opts);
    for (const path of ["/account", "/account/settings"]) {
      await go(page, path);
      check(`${label}: ${path} fits the phone width`, await fits(page));
      check(`${label}: ${path} keeps the bill on Home`, path !== "/account" || (await page.locator("#w-bill").count()) === 1);
    }
    await axe(page, `${label}: Settings`);
    await page.context().close();
  }
}

check("no console errors", problems.length === 0, problems.join("\n      "));
await browser.close();
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
