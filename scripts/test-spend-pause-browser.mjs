// Browser tests for Spend Pause, against the production build, using installed Chrome.
// Usage: npm run build, then npm run test:browser. Adds no project dependency: npm exec fetches the tools.
// Set SHOTS=<folder> to save screenshots.

import { execSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const toolsDir = dirname(realpathSync(execSync("command -v playwright-core", { shell: "/bin/sh" }).toString().trim()));
const { chromium } = await import(join(toolsDir, "index.mjs"));
const axeSource = readFileSync(createRequire(join(toolsDir, "index.js")).resolve("axe-core"), "utf8");

const PORT = 3214;
const BASE = `http://localhost:${PORT}`;
const PAUSE = `${BASE}/account/spend-pause`;
const CHECK = `${PAUSE}/check`;
const SHOP = `${BASE}/demo/shop`;
const SHOTS = process.env.SHOTS;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

let failures = 0;
const check = (name, passed, detail = "") => {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed || !detail ? "" : `\n      ${detail}`}`);
};

const server = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], {
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: "ignore",
  detached: true,
});
for (let attempt = 0; ; attempt += 1) {
  try {
    await fetch(PAUSE);
    break;
  } catch (error) {
    if (attempt > 100) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const problems = [];

async function open({ mode = "complex", viewport = PHONE, reducedMotion, init } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion });
  await context.addCookies([{ name: "cfe-mode", value: mode, domain: "localhost", path: "/" }]);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) problems.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
  return page;
}

const ready = (page) => page.getByRole("heading", { name: /Spend Pause is (on|off)/ }).waitFor();
const toggle = (page, name) => page.getByRole("button", { name }).click();
const dialog = (page) => page.getByRole("alertdialog");
const shot = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500); // let the page transition finish
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};
async function axe(page, label) {
  await page.waitForTimeout(500); // colours are only final once the page transition ends
  await page.addScriptTag({ content: axeSource });
  const found = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] });
    return result.violations.map((v) => `${v.id}: ${v.nodes[0].html.slice(0, 90)} ${v.nodes[0].failureSummary?.replace(/\s+/g, " ").slice(0, 240)}`);
  });
  check(`axe: ${label}`, found.length === 0, found.join(" ; "));
}
/** The current balance is on the Complex home. Simple home shows the statement bill, which a pending purchase doesn't change. */
const complexHome = async (page) => {
  await page.context().addCookies([{ name: "cfe-mode", value: "complex", domain: "localhost", path: "/" }]);
  await page.goto(`${BASE}/account`);
  await page.getByText("Current balance").first().waitFor();
};
const setMode = (page, value) => page.context().addCookies([{ name: "cfe-mode", value, domain: "localhost", path: "/" }]);
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const buy = async (page) => {
  await page.goto(SHOP);
  await page.getByRole("button", { name: "Buy" }).click();
};

try {
  for (const mode of ["complex", "simple"]) {
    console.log(`\n${mode} mode`);
    let page = await open({ mode });
    await page.goto(PAUSE);
    await ready(page);
    check("starts on, from the demo settings", await page.getByRole("heading", { name: "Spend Pause is on" }).isVisible());
    check("says what it checks", await page.getByText("Any purchase over £100.00").isVisible());
    await shot(page, `${mode}-on`);
    await axe(page, `${mode} status`);

    await toggle(page, "Turn off Spend Pause");
    check("turning off asks first", await dialog(page).isVisible());
    await shot(page, `${mode}-confirm-off`);
    await axe(page, `${mode} confirmation`);
    await page.getByRole("button", { name: "Not now" }).click();
    await dialog(page).waitFor({ state: "hidden" });
    check("cancelling changes nothing", await page.getByRole("heading", { name: "Spend Pause is on" }).isVisible());

    await toggle(page, "Turn off Spend Pause");
    await page.getByRole("button", { name: "Yes, turn it off" }).click();
    await page.getByRole("heading", { name: "Spend Pause is off" }).waitFor();
    check("confirming turns it off", true);
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("heading", { name: "Spend Pause is on" }).waitFor();
    check("undo restores it", true);

    await toggle(page, "Turn off Spend Pause");
    await page.getByRole("button", { name: "Yes, turn it off" }).click();
    await page.getByRole("heading", { name: "Spend Pause is off" }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Spend Pause is off" }).waitFor();
    check("stays off after a reload", true);
    await page.goto(`${PAUSE}?confirm=off`);
    await ready(page);
    check("a link can't reopen a change already made", !(await dialog(page).isVisible()));
    await page.goto(`${PAUSE}?confirm=on`);
    await dialog(page).waitFor();
    check("a Dial link only opens the question", (await page.locator("#pause-status").innerText()) === "Spend Pause is off");
    await page.getByRole("button", { name: "Yes, turn it on" }).click();
    await page.getByRole("heading", { name: "Spend Pause is on" }).waitFor();
    await page.goto(`${PAUSE}?confirm=on`);
    await ready(page);
    check("repeating activation does nothing", !(await dialog(page).isVisible()));
    await page.context().close();

    page = await open({ mode });
    await buy(page);
    await page.waitForURL("**/spend-pause/check");
    await page.getByRole("button", { name: "Go ahead" }).waitFor();
    const sentence = "This £120.00 purchase is over the £100.00 you asked us to check, and would take you £22.35 over your £500.00 monthly budget.";
    check("pause shows the exact reasons", await page.getByText(sentence).isVisible());
    await shot(page, `${mode}-pause`);
    await axe(page, `${mode} pause`);
    if (mode === "simple") {
      const offered = await page.getByRole("button", { name: "Read aloud" }).isVisible();
      check("read aloud is offered, and doesn't play by itself", offered && !(await page.evaluate(() => speechSynthesis.speaking)));
    } else {
      const text = await dialog(page).innerText();
      check("dialog shows balance and credit after", text.includes("£1,189.89") && text.includes("£310.11"));
      await page.keyboard.press("Escape");
      check("the check can't be dismissed without an answer", await dialog(page).isVisible());
    }
    await page.getByRole("button", { name: "Cancel it" }).click();
    await page.getByRole("heading", { name: "Purchase cancelled" }).waitFor();
    check("focus moves to the result", await page.evaluate(() => document.activeElement?.textContent === "Purchase cancelled"));
    await page.goto(`${BASE}/account/spending`);
    await page.locator("main").waitFor();
    check("cancelling adds no transaction", !(await page.locator("main").innerText()).includes("Northwind Audio"));
    await complexHome(page);
    check("cancelling leaves the balance alone", (await page.locator("main").innerText()).includes("£1,069.89"));
    await setMode(page, mode);

    await buy(page);
    await page.waitForURL("**/spend-pause/check");
    await page.getByRole("button", { name: "Go ahead" }).click();
    await page.getByRole("heading", { name: "Purchase made" }).waitFor();
    await shot(page, `${mode}-done`);
    await page.getByRole("link", { name: "See your spending" }).click();
    await page.waitForURL("**/account/spending");
    await page.getByText("Northwind Audio").first().waitFor();
    check("going ahead adds it to spending", true);
    await complexHome(page);
    await page.getByText("£1,189.89").first().waitFor();
    check("the balance matches what the check promised", true);
    await setMode(page, mode);
    await page.goto(PAUSE);
    await page.getByText("you cancelled it").waitFor();
    check("recent choices are listed", await page.getByText("you went ahead").isVisible());
    await page.reload();
    await page.getByText("you went ahead").waitFor();
    check("the session survives a reload", true);
    await page.context().close();
  }

  console.log("\nSettings");
  let page = await open({ mode: "complex" });
  await page.goto(PAUSE);
  await ready(page);
  await toggle(page, "Change what's checked");
  await page.getByLabel("Another amount").check();
  await page.getByLabel("Amount in pounds").fill("lots");
  await page.getByRole("button", { name: "Save choices" }).click();
  await page.getByText("Enter an amount in pounds").waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "threshold-other");
  check("a bad amount is explained, and focus lands on it", true);
  await shot(page, "complex-form-error");
  // Tall enough that the sticky tab bar overlaps nothing, so target sizes are measured on their own.
  await page.setViewportSize({ width: 390, height: 1400 });
  await axe(page, "complex form with an error");
  await page.setViewportSize(PHONE);
  await page.getByLabel("Amount in pounds").fill("75.50");
  await page.getByLabel("Yes, set quiet hours").check();
  await page.getByRole("button", { name: "Save choices" }).click();
  await page.getByText("Any purchase over £75.50").waitFor();
  check("custom amount saved", await page.getByText("Any purchase between 22:00 and 06:00").isVisible());
  await page.reload();
  await page.getByText("Any purchase over £75.50").waitFor();
  check("custom choices survive a reload", true);
  await page.context().close();

  page = await open({ mode: "simple" });
  await page.goto(PAUSE);
  await ready(page);
  await toggle(page, "Change what's checked");
  await page.getByText("Question 1 of 4").waitFor();
  check("Simple asks one question at a time", (await page.getByText("Do you want a monthly budget?").count()) === 0);
  await page.getByLabel("Over £50").check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByText("Do you want a monthly budget?").waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === "Question 2 of 4");
  check("focus follows to the next question", true);
  await shot(page, "simple-question");
  await axe(page, "simple question");
  await page.getByLabel("No monthly budget").check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByText("Is this right?").waitFor();
  await page.getByRole("button", { name: "Save choices" }).click();
  await page.getByText("Any purchase over £50.00").waitFor();
  check("Simple saves its choices", (await page.getByText("monthly budget").count()) === 0);
  await page.context().close();

  page = await open({ mode: "complex" });
  await page.goto(PAUSE);
  await ready(page);
  await toggle(page, "Change what's checked");
  await page.getByLabel("Don't check by amount").check();
  await page.getByLabel("No monthly budget").check();
  await page.getByRole("button", { name: "Save choices" }).click();
  await page.getByText("Choose at least one thing").waitFor();
  check("can't save with nothing to check", true);
  await page.context().close();

  console.log("\nKeyboard only");
  page = await open({ mode: "complex", viewport: DESKTOP });
  await page.goto(PAUSE);
  await ready(page);
  await page.getByRole("button", { name: "Turn off Spend Pause" }).focus();
  const focusVisible = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return style.outlineStyle !== "none" || style.boxShadow !== "none";
  });
  check("focus is visible", focusVisible);
  await page.keyboard.press("Enter");
  await dialog(page).waitFor();
  await page.waitForFunction(() => !!document.activeElement?.closest('[role="alertdialog"]'));
  check("focus moves into the dialog", true);
  const inside = [];
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(100); // the focus trap moves through a guard element first
    inside.push(await page.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]')));
  }
  check("tab stays inside the dialog", inside.every(Boolean));
  await page.keyboard.press("Escape");
  await dialog(page).waitFor({ state: "hidden" });
  check("Escape cancels, with no change", await page.getByRole("heading", { name: "Spend Pause is on" }).isVisible());
  check("focus returns after closing", await page.evaluate(() => document.activeElement && document.activeElement !== document.body));
  await page.getByRole("button", { name: "Turn off Spend Pause" }).focus();
  await page.keyboard.press("Space");
  await dialog(page).waitFor();
  await page.getByRole("button", { name: "Yes, turn it off" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Spend Pause is off" }).waitFor();
  check("the whole change works by keyboard", true);
  await page.context().close();

  for (const mode of ["complex", "simple"]) {
    page = await open({ mode, viewport: { width: 390, height: 600 } });
    await page.goto(PAUSE);
    await ready(page);
    await toggle(page, "Change what's checked");
    await page.getByRole("button", { name: mode === "complex" ? "Cancel" : "Next" }).waitFor();
    const hidden = [];
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(60);
      const covered = await page.evaluate(() => {
        const el = document.activeElement;
        const bar = document.querySelector('nav[aria-label="Main"]');
        if (!el || el === document.body || !bar || bar.contains(el)) return null;
        const box = el.getBoundingClientRect();
        return box.bottom > bar.getBoundingClientRect().top + 1 ? `${el.tagName} ${el.textContent?.slice(0, 20)}` : null;
      });
      if (covered) hidden.push(covered);
    }
    check(`${mode}: focused controls are never hidden behind the tab bar`, hidden.length === 0, hidden.join(", "));
    await page.context().close();
  }

  console.log("\nDemo shop");
  page = await open({
    mode: "complex",
    init: () => localStorage.setItem("cfe-spend-pause-settings", JSON.stringify({ enabled: false, singlePurchaseThreshold: 10000, monthlyBudget: 50000, quietHours: null })),
  });
  await buy(page);
  await page.getByText("Spend Pause didn't need to check this one").waitFor();
  check("with it off, a purchase goes straight through", page.url() === SHOP);
  await shot(page, "shop-off");
  await page.context().close();

  page = await open({ mode: "complex" });
  await page.goto(SHOP);
  await page.getByText("made-up demo shop").waitFor();
  check("the shop says it isn't real", true);
  await axe(page, "shop");
  await page.getByRole("button", { name: "Buy" }).dblclick();
  await page.waitForURL("**/spend-pause/check");
  await page.getByRole("button", { name: "Go ahead" }).click();
  await page.getByRole("heading", { name: "Purchase made" }).waitFor();
  await page.goto(`${BASE}/account/spending`);
  await page.getByText("Northwind Audio").first().waitFor();
  const rows = (await page.locator("main").innerText()).split("Northwind Audio").length - 1;
  check("a double tap buys once", rows === 1, `${rows} rows`);
  await page.context().close();

  page = await open({ mode: "simple" });
  await page.goto(CHECK);
  await page.getByRole("heading", { name: "Nothing to check" }).waitFor();
  check("no purchase waiting is handled", true);
  await buy(page);
  await page.waitForURL("**/spend-pause/check");
  await page.getByRole("button", { name: "Go ahead" }).waitFor();
  await page.goto(PAUSE);
  await ready(page);
  check("a waiting purchase is flagged", await page.getByText("A purchase is waiting for your answer.").isVisible());
  await page.goto(SHOP);
  await page.getByRole("link", { name: /purchase waiting/ }).waitFor();
  check("the shop won't start a second purchase", (await page.getByRole("button", { name: "Buy" }).count()) === 0);
  await page.reload();
  await page.getByRole("link", { name: /purchase waiting/ }).click();
  await page.getByRole("button", { name: "Go ahead" }).waitFor();
  check("a waiting purchase survives a reload", true);
  await page.context().close();

  console.log("\nStorage trouble");
  const blocked = () => {
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(window, name, {
        get() {
          throw new Error("blocked");
        },
      });
    }
  };
  page = await open({ mode: "complex", init: blocked });
  await page.goto(PAUSE);
  await ready(page);
  check("works with storage blocked", true);
  await toggle(page, "Turn off Spend Pause");
  await page.getByRole("button", { name: "Yes, turn it off" }).click();
  await page.getByText("We can't save your choices on this device").waitFor();
  check("says the choice won't be saved", true);
  await page.context().close();

  page = await open({ mode: "complex", init: () => localStorage.setItem("cfe-spend-pause-settings", "{oops") });
  await page.goto(PAUSE);
  await ready(page);
  check("damaged storage falls back to the defaults", await page.getByRole("heading", { name: "Spend Pause is on" }).isVisible());
  await page.context().close();

  console.log("\nLayouts");
  for (const [label, viewport] of [
    ["phone", PHONE],
    ["desktop", DESKTOP],
    ["200% zoom", { width: 640, height: 400 }],
    ["400% zoom", { width: 320, height: 200 }],
  ]) {
    for (const mode of ["complex", "simple"]) {
      page = await open({ mode, viewport, reducedMotion: "reduce" });
      await page.goto(PAUSE);
      await ready(page);
      const status = await fits(page);
      await toggle(page, "Turn off Spend Pause");
      const confirm = page.getByRole("button", { name: "Yes, turn it off" });
      await confirm.scrollIntoViewIfNeeded();
      const reachable = await confirm.isVisible();
      await page.getByRole("button", { name: "Not now" }).click();
      await buy(page);
      await page.waitForURL("**/spend-pause/check");
      const go = page.getByRole("button", { name: "Go ahead" });
      await go.waitFor();
      await go.scrollIntoViewIfNeeded();
      check(`${label}, ${mode}: nothing overflows, and answers can be reached`, status && reachable && (await fits(page)) && (await go.isVisible()));
      if (label === "400% zoom") await shot(page, `${mode}-zoom-400`);
      await page.context().close();
    }
  }

  console.log("\nThe rest of the app");
  page = await open({ mode: "complex" });
  for (const [path, text] of [
    ["/account", "Current balance"],
    ["/account/spending", "Tesco"],
    ["/account/pay", "Pay"],
  ]) {
    await page.goto(`${BASE}${path}`);
    check(`${path} still works`, (await page.locator("main").innerText()).includes(text));
  }
  await page.goto(`${BASE}/account`);
  await page.getByRole("link", { name: "Pause" }).click();
  await page.waitForURL("**/spend-pause");
  await ready(page);
  check("the Pause tab opens it, and marks the current page", (await page.getByRole("link", { name: "Pause" }).getAttribute("aria-current")) === "page");
  await page.context().close();

  const real = problems.filter((p) => !p.includes("404"));
  check("no console or page errors anywhere", real.length === 0, [...new Set(real)].slice(0, 4).join(" | "));
} catch (error) {
  failures += 1;
  console.log(`FAIL  the run stopped early: ${String(error).split("\n").slice(0, 3).join(" ").slice(0, 400)}`);
} finally {
  await browser.close();
  if (server.pid) process.kill(-server.pid);
}

console.log(`\n${failures === 0 ? "All passed" : `${failures} failed`}`);
process.exit(failures > 0 ? 1 : 0);
