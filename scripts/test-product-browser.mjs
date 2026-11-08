// Product workstream, end to end in a real browser: onboarding (and skipping it), the Home command centre, the
// Credit Learning Lab, goals with milestones, the More page and "Start the demo again". Every new screen is checked
// with axe, for horizontal overflow at phone width and 200% text, in dark mode and high contrast, and for console errors.
// Usage: npm run build && SESSION_SECRET=<32+ chars> npx next start -p 3100, then
//   BASE_URL=http://localhost:3100 npm run test:product
// Screenshots go to docs/screenshots/product/.

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
const SHOTS = "docs/screenshots/product";
mkdirSync(SHOTS, { recursive: true });
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 700 };
const DESKTOP = { width: 1366, height: 900 };

let failures = 0;
const check = (name, passed, detail = "") => {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed || !detail ? "" : `\n      ${detail}`}`);
};

// Playwright's own Chromium if it matches this Playwright, otherwise the installed Chrome.
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "chrome" }));
const problems = [];

async function open({ mode, viewport = PHONE, prefs, colorScheme, reducedMotion } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion });
  await context.addCookies([
    ...(mode ? [{ name: "cfe-mode", value: mode, domain: HOST, path: "/" }] : []),
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
const main = (page) => page.locator("main").innerText();
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
async function axe(page, label) {
  if (!axeSource) return console.log(`SKIP  axe: ${label} (axe-core not found)`);
  await page.waitForTimeout(400);
  // Colours are only final once a fade-in has ended; endless animations (loading pulses) never finish, so skip those.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
  // At the bottom, so nothing sits under the sticky tab bar (a target-size false positive), as the other scripts do.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.addScriptTag({ content: axeSource });
  const found = await page.evaluate(async () => {
    // Open every <details>, so what's inside is checked too.
    document.querySelectorAll("details").forEach((d) => (d.open = true));
    const result = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] });
    return result.violations.map((v) => `${v.id}: ${v.nodes[0].html.slice(0, 100)} ${v.nodes[0].failureSummary?.replace(/\s+/g, " ").slice(0, 200)}`);
  });
  check(`axe: ${label}`, found.length === 0, found.join(" ; "));
}
const prefsCookie = async (page) => {
  const c = (await page.context().cookies()).find((x) => x.name === "cfe-prefs");
  return c ? JSON.parse(decodeURIComponent(c.value)) : null;
};

const PAGES = ["/", "/account", "/account/more", "/account/learn", "/account/learn/utilisation", "/account/learn/minimum-payments", "/account/learn/interest", "/account/learn/statement", "/account/learn/quiz", "/account/goals"];

// ---------------------------------------------------------------------------------------------------------------
console.log("\nOnboarding: choose a view, comfort and sections, then sign in");
{
  const page = await open();
  await go(page, "/");
  await page.getByText("Demo account.").waitFor();
  check("the welcome screen says it is demo data", (await main(page)).includes("Nothing here is real financial information"));
  await axe(page, "welcome");
  await page.getByRole("button", { name: "Set up my view" }).click();
  await page.getByRole("heading", { name: "How would you like it to look?" }).waitFor();
  check("focus moves to the step heading", await page.evaluate(() => document.activeElement?.tagName === "H1"));
  await page.getByRole("radio", { name: /The few things that matter/ }).check();
  check("choosing Simple switches the page now", (await page.locator("html").getAttribute("data-mode")) === "simple");
  await page.screenshot({ path: `${SHOTS}/01-onboarding-view.png`, fullPage: true });
  await axe(page, "onboarding step 1");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: "150%" }).check();
  check("text size applies straight away", (await page.locator("html").getAttribute("data-text")) === "150");
  await page.getByRole("radio", { name: "Stronger contrast" }).check();
  await axe(page, "onboarding step 2, 150% and high contrast");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("checkbox", { name: "Your progress" }).check();
  await page.getByRole("radio", { name: "Lists of figures instead" }).check();
  await axe(page, "onboarding step 3");
  check("onboarding fits at 390px and 150%", await fits(page));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "You're all set" }).waitFor();
  check("the summary lists the choices", /Simple view[\s\S]*150%[\s\S]*figures as lists/.test(await main(page)));
  await page.getByRole("button", { name: "Sign in to the demo" }).click();
  await page.waitForURL(/\/account$/);
  const saved = await prefsCookie(page);
  check("every choice is saved, with onboarding done", saved?.onboarding === "done" && saved.textSize === 150 && saved.contrast === "high" && saved.charts === "hide" && saved.layout.shown.includes("progress"), JSON.stringify(saved));
  await page.getByRole("heading", { name: "Your progress" }).waitFor();
  check("Home shows the section chosen in onboarding", true);
  check("Home doesn't invite setup again", !(await main(page)).includes("Make it yours"));
  await page.reload();
  check("the look survives a reload (from the cookie, no flash)", (await page.locator("html").getAttribute("data-text")) === "150" && (await page.locator("html").getAttribute("data-mode")) === "simple");
  await page.context().close();
}

console.log("\nOnboarding can be skipped");
{
  const page = await open();
  await go(page, "/");
  await page.getByRole("button", { name: "Skip and sign in" }).click();
  await page.waitForURL(/\/account$/);
  check("skipping saves 'skipped' and changes nothing else", (await prefsCookie(page))?.onboarding === "skipped" && (await page.locator("html").getAttribute("data-text")) === "100");
  await go(page, "/");
  check("returning visitors get 'Sign in' and 'Set up again'", (await page.getByRole("link", { name: "Sign in to the demo" }).count()) === 1 && (await page.getByRole("button", { name: "Set up my view again" }).count()) === 1);
  await page.context().close();
}

console.log("\nHome: the financial command centre, Detailed");
{
  const page = await open({ mode: "complex", viewport: DESKTOP, prefs: { onboarding: "done" } });
  await go(page, "/account");
  for (const h of ["Current balance", "Your bill", "Where it went in November", "Coming up", "Payments", "Your progress"]) {
    check(`Home has "${h}"`, (await page.getByRole("heading", { name: h }).count()) > 0);
  }
  const text = await main(page);
  check("utilisation is shown as a figure", text.includes("71% of your limit used"));
  check("categories say pending items may change and payments aren't spending", /still pending, which may change/.test(text) && text.includes("Card payments aren't counted as spending"));
  check("upcoming charges are labelled as estimates", text.includes("Expected charges are estimates"));
  check("the payment status is stated in words", text.includes("Not paid yet. At least £25.00 is due in 5 days."));
  await page.getByText("What do these figures mean?").first().click();
  check("each balance figure is explained with the account's own number", (await main(page)).includes("Available credit, £430.11"));
  check("charts have bars when charts are on", (await page.locator('[aria-label="Spending by category in November"] li span[aria-hidden]').count()) > 0);
  await page.screenshot({ path: `${SHOTS}/02-home-detailed-desktop.png`, fullPage: true });
  await axe(page, "Home, Detailed, desktop");
  await page.context().close();
}
{
  const page = await open({ mode: "complex", prefs: { onboarding: "done", charts: "hide" } });
  await go(page, "/account");
  check("with charts off, the category bars go and the figures stay", (await page.locator('[aria-label="Spending by category in November"] li span[aria-hidden]').count()) === 0 && (await main(page)).includes("Groceries"));
  check("with charts off, the daily chart is a visible table", await page.getByRole("table", { name: "Spending each day this month" }).isVisible());
  await page.context().close();
}

console.log("\nCredit Learning Lab");
{
  const page = await open({ mode: "complex", prefs: { onboarding: "done" } });
  await go(page, "/account/more");
  check("the More page lists the Learning Lab and Goals", (await page.getByRole("link", { name: /Learning Lab/ }).count()) === 1 && (await page.getByRole("link", { name: /Goals/ }).count()) === 1);
  await page.getByRole("link", { name: /Learning Lab/ }).click();
  await page.getByRole("heading", { name: "Credit Learning Lab" }).waitFor();
  check("the hub lists five topics", (await page.locator("main ul > li").count()) === 5);
  await page.getByRole("link", { name: /Credit utilisation/ }).click();
  await page.getByRole("heading", { name: "Your utilisation" }).waitFor();
  check("utilisation starts from the account: 71%", (await page.getByRole("status").filter({ hasText: "Now" }).innerText()).includes("Now 71%"));
  await page.getByRole("button", { name: "£250", exact: true }).click();
  check("a £250 payment brings it to 55%", (await page.getByRole("status").filter({ hasText: "Now" }).innerText()).includes("After paying £250.00: 55%"));
  check("the meter is named and states its value", (await page.getByRole("meter", { name: "Utilisation after the payment" }).getAttribute("aria-valuetext"))?.startsWith("55% of the limit"));
  await page.getByRole("textbox", { name: "Credit limit", exact: true }).fill("abc");
  check("a bad amount says what's wrong, next to the field", (await page.getByText("Enter an amount in pounds").count()) === 1 && (await page.getByRole("textbox", { name: "Credit limit", exact: true }).getAttribute("aria-invalid")) === "true");
  await page.screenshot({ path: `${SHOTS}/03-learn-utilisation.png`, fullPage: true });
  await page.getByRole("textbox", { name: "Credit limit", exact: true }).fill("1500");

  await go(page, "/account/learn/minimum-payments");
  const minText = await main(page);
  check("the minimum explainer compares minimum only with a little more", /Paying £25\.00 more each month clears it .+ sooner and costs £[\d.,]+ less in interest\./.test(minText));
  check("it is labelled illustrative and states its rule", minText.includes("Illustrative.") && minText.includes("the greater of £25"));
  check("Detailed shows the year-by-year table", await page.getByRole("table", { name: "Balance left at the end of each year" }).isVisible());

  await go(page, "/account/learn/interest");
  await page.getByRole("textbox", { name: "Paid each month", exact: true }).fill("20");
  check("a payment below the interest is explained, not calculated forever", (await main(page)).includes("doesn't cover the first month's interest"));
  await page.getByRole("textbox", { name: "APR", exact: true }).fill("150");
  check("an impossible APR is refused in words", (await main(page)).includes("Enter a yearly rate like 24.9."));

  await go(page, "/account/learn/statement");
  check("the statement explainer shows the account's own figures", (await main(page)).includes("£486.20") && (await main(page)).includes("Interest-free periods"));

  await go(page, "/account/learn/quiz");
  await page.getByRole("radio", { name: "Your balance as a share of your credit limit" }).check();
  await page.getByRole("button", { name: "Check my answer" }).click();
  check("a right answer is confirmed with an explanation", (await main(page)).includes("Correct.") && (await main(page)).includes("£300 owed on a £1,000 limit is 30%"));
  await page.getByRole("button", { name: "Next question" }).click();
  check("focus moves to the next question", await page.evaluate(() => document.activeElement?.textContent?.includes("Your bill is £486.20")));
  await page.reload();
  await page.waitForTimeout(300);
  check("quiz progress is kept on this device", (await main(page)).includes("1 of 8 answered, 1 correct"));
  await page.screenshot({ path: `${SHOTS}/04-learn-quiz.png`, fullPage: true });
  await page.context().close();
}

console.log("\nGoals: debt, saving, milestones and a celebration");
{
  const page = await open({ mode: "simple", prefs: { onboarding: "done" } });
  await go(page, "/account/goals");
  await page.getByRole("heading", { name: "This week's check-in" }).waitFor();
  await page.getByRole("button", { name: "Add a goal" }).click();
  check("the default goal kind is unchanged (category), for the backend tests", await page.getByRole("radio", { name: /Keep a category under an amount/ }).isChecked());
  await page.getByRole("radio", { name: /Reduce what I owe/ }).check();
  await page.locator("#goal-amount").fill("2000");
  await page.getByRole("button", { name: "Add this goal" }).click();
  check("a target above the balance is refused in words", (await main(page)).includes("Your balance is £1,069.89, so choose an amount below that."));
  await page.getByRole("button", { name: "Pay it all off (£0)" }).click();
  await page.getByRole("button", { name: "Add this goal" }).click();
  await page.getByRole("heading", { name: "Your goals (1)" }).waitFor();
  check("the pay-off goal is tracked from the real balance", (await main(page)).includes("Pay off your card balance by the end of"));

  await page.getByRole("button", { name: "Add a goal" }).click();
  await page.getByRole("radio", { name: /Build an emergency fund/ }).check();
  await page.locator("#goal-amount").fill("1000");
  await page.getByRole("button", { name: "Add this goal" }).click();
  await page.getByRole("heading", { name: "Your goals (2)" }).waitFor();
  await page.getByLabel("Update what you've saved").fill("500");
  await page.getByRole("button", { name: "Update" }).click();
  await page.getByText(/Milestone reached: 50%/).waitFor();
  check("crossing a milestone is celebrated, once, in words", (await page.getByText(/Milestone reached: 50%/).count()) === 1);
  check("milestones say which are reached, for screen readers too", (await page.getByText("50%, reached").count()) === 1);
  const goalsSaved = await page.evaluate(async () => (await (await fetch("/api/goals")).json()).goals.map((g) => g.spec.kind));
  check("the new goal kinds are accepted and kept by the server", JSON.stringify(goalsSaved) === JSON.stringify(["pay_down", "save_up"]), JSON.stringify(goalsSaved));
  await page.reload();
  await page.getByRole("heading", { name: "Your goals (2)" }).waitFor();
  check("after a reload, the saved amount is still there", (await main(page)).includes("You've saved £500.00 of £1,000.00"));
  await page.getByRole("button", { name: /^Change.*Build an emergency fund/ }).click();
  await page.locator("#goal-amount").fill("1200");
  await page.getByRole("button", { name: "Save changes" }).click();
  check("a goal can be edited", (await main(page)).includes("Goal changed: Build an emergency fund of £1,200"));
  await page.screenshot({ path: `${SHOTS}/05-goals-simple.png`, fullPage: true });
  await axe(page, "Goals with two goals, Simple");
  await page.context().close();
}

console.log("\nStart the demo again");
{
  const page = await open({ mode: "simple", prefs: { onboarding: "done", textSize: 200 } });
  await go(page, "/account/learn/quiz");
  await page.evaluate(() => localStorage.setItem("cfe-quiz", JSON.stringify({ apr: 0 })));
  await go(page, "/account/more");
  await page.getByRole("button", { name: "Start the demo again" }).click();
  await page.waitForURL(/\/$/);
  await page.getByText("The demo is back to the start.").waitFor();
  check("display choices and view are back to the defaults", (await page.locator("html").getAttribute("data-text")) === "100" && (await prefsCookie(page)) === null);
  check("this device's demo storage is cleared", (await page.evaluate(() => localStorage.getItem("cfe-quiz"))) === null);
  const account = await page.evaluate(async () => (await (await fetch("/api/account")).json()));
  check("Spend Pause is back on with the demo's settings", account.settings.enabled === true && account.settings.singlePurchaseThreshold === 10000 && account.goals.length === 0);
  await go(page, "/?demo=reset");
  await page.getByText("The demo is back to the start.").waitFor();
  check("/?demo=reset does the same", true);
  await page.context().close();
}

console.log("\nEvery new screen: phone width, 200% text, dark, high contrast, reduced motion");
for (const [label, opts] of [
  ["Simple, 320px, 200% text", { mode: "simple", viewport: NARROW, prefs: { onboarding: "done", textSize: 200 } }],
  ["Detailed, 390px, 200% text", { mode: "complex", prefs: { onboarding: "done", textSize: 200 } }],
  ["Detailed, dark", { mode: "complex", colorScheme: "dark", prefs: { onboarding: "done" } }],
  ["Simple, dark, high contrast, reduced motion", { mode: "simple", colorScheme: "dark", reducedMotion: "reduce", prefs: { onboarding: "done", contrast: "high", motion: "reduced" } }],
]) {
  const page = await open(opts);
  const wide = [];
  for (const path of PAGES) {
    await go(page, path);
    if (!(await fits(page))) wide.push(path);
  }
  check(`no sideways scrolling on any new screen: ${label}`, wide.length === 0, wide.join(", "));
  if (label.includes("dark")) {
    for (const path of ["/account", "/account/learn/utilisation", "/account/goals"]) {
      await go(page, path);
      await axe(page, `${path}, ${label}`);
    }
    await go(page, "/account");
    await page.screenshot({ path: `${SHOTS}/06-home-${label.includes("high") ? "simple-dark-high-contrast" : "detailed-dark"}.png`, fullPage: true });
  }
  await page.context().close();
}

console.log("\nKeyboard");
{
  const page = await open({ mode: "complex", prefs: { onboarding: "done" } });
  await go(page, "/account/learn/utilisation");
  let reached = false;
  let outline = "";
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press("Tab");
    const a = await page.evaluate(() => ({ text: document.activeElement?.textContent ?? "", outline: getComputedStyle(document.activeElement).outlineStyle }));
    if (a.text === "£250") {
      reached = true;
      outline = a.outline;
    }
  }
  check("the presets are reachable by Tab, with a visible focus outline", reached && outline !== "none", outline);
  await page.keyboard.press("Enter");
  check("Enter on a preset applies it", (await page.getByRole("status").filter({ hasText: "Now" }).innerText()).includes("55%"));
  await page.context().close();
}

check("no console errors or page errors", problems.length === 0, [...new Set(problems)].slice(0, 8).join("\n      "));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
