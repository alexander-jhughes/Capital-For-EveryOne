// The screens Dial navigates to: Spending filters from the URL, ?txn= detail, and Home ?focus=.
// Usage: start the app (npx next dev -p 3100, or npm run build && npx next start -p 3100), then
//   BASE_URL=http://localhost:3100 node scripts/test-dial-screens-browser.mjs
// Uses Playwright if it is installed globally, otherwise playwright-core through npm exec (like the other scripts).

import { execSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

async function loadChromium() {
  try {
    return require("playwright").chromium;
  } catch {
    const toolsDir = dirname(realpathSync(execSync("command -v playwright-core", { shell: "/bin/sh" }).toString().trim()));
    return (await import(join(toolsDir, "index.mjs"))).chromium;
  }
}
function loadAxe() {
  try {
    return readFileSync(require.resolve("axe-core"), "utf8");
  } catch {
    return null;
  }
}

const chromium = await loadChromium();
const axeSource = loadAxe();
const BASE = (process.env.BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const SPENDING = `${BASE}/account/spending`;
const HOME = `${BASE}/account`;
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 700 };

let failures = 0;
const check = (name, passed, detail = "") => {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed || !detail ? "" : `\n      ${detail}`}`);
};

const browser = await chromium.launch();
const problems = [];

async function open({ mode = "complex", viewport = PHONE, prefs, reducedMotion } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion });
  const host = new URL(BASE).hostname;
  await context.addCookies([
    { name: "cfe-mode", value: mode, domain: host, path: "/" },
    ...(prefs ? [{ name: "cfe-prefs", value: encodeURIComponent(JSON.stringify(prefs)), domain: host, path: "/" }] : []),
  ]);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|503|Failed to load resource/.test(m.text())) problems.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
  return page;
}

/** Load a page and wait until React has hydrated it (links then navigate on the client). */
async function go(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => !!window.next?.router);
  await page.waitForTimeout(150);
}

const status = (page) => page.locator("#sf-h ~ p[role=status]").innerText();
const complexRows = (page) => page.locator('section[aria-labelledby="sp-tx"] [data-txn]').count();
const simpleRows = (page) => page.locator('section[aria-labelledby="filtered-h"] [data-txn]').count();
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const activeInfo = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, id: a?.id ?? "", txn: a?.getAttribute("data-txn-detail") ?? "", text: (a?.textContent ?? "").slice(0, 80) };
  });
/** Waits for a smooth scroll to bring the element on screen. */
const inViewport = (page, selector) =>
  page
    .waitForFunction(
      (s) => {
        const r = document.querySelector(s)?.getBoundingClientRect();
        return !!r && r.bottom > 0 && r.top < window.innerHeight;
      },
      selector,
      { timeout: 3000 },
    )
    .then(() => true, () => false);

async function axe(page, label) {
  if (!axeSource) {
    console.log(`SKIP  axe: ${label} (axe-core not found)`);
    return;
  }
  await page.waitForTimeout(400);
  // Like the other scripts: at the bottom, so nothing sits under the fixed tab bar (a target-size false positive).
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.addScriptTag({ content: axeSource });
  const found = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] });
    return result.violations.map((v) => `${v.id}: ${v.nodes[0].html.slice(0, 90)} ${v.nodes[0].failureSummary?.replace(/\s+/g, " ").slice(0, 200)}`);
  });
  check(`axe: ${label}`, found.length === 0, found.join(" ; "));
}

try {
  console.log("\nSpending filters from the URL (Detailed)");
  {
    const page = await open();
    await go(page, `${SPENDING}?category=Groceries&month=2026-10`);
    check("filter bar announces the filtered figures", (await status(page)) === "Showing Groceries in October: 10 purchases, £318.30", await status(page));
    check("10 rows listed", (await complexRows(page)) === 10, String(await complexRows(page)));
    check("chips for category and month", (await page.getByRole("link", { name: "Remove Category: Groceries" }).count()) === 1 && (await page.getByRole("link", { name: "Remove Month: October" }).count()) === 1);
    check("summary card is October, whole month", (await page.locator("#sp-total").innerText()).startsWith("October, 1 Oct to 31 Oct"), await page.locator("#sp-total").innerText());
    check("Where it went highlights Groceries", (await page.locator("tr[data-filtered] th").innerText()).startsWith("Groceries"));
    await axe(page, "Spending, filtered, Detailed");

    await page.getByRole("link", { name: "Remove Month: October" }).click();
    await page.waitForURL((u) => u.search === "?category=Groceries");
    await page.waitForFunction(() => document.querySelector("#sf-h ~ p[role=status]")?.textContent?.startsWith("Showing Groceries:"));
    check("removing the month chip updates the URL", new URL(page.url()).search === "?category=Groceries", page.url());
    check("and the list (17 Groceries purchases in all)", (await complexRows(page)) === 17 && (await status(page)).includes("17 purchases"), `${await complexRows(page)} / ${await status(page)}`);
    check("focus doesn't fall to the page body", (await activeInfo(page)).tag !== "BODY", JSON.stringify(await activeInfo(page)));

    await page.goBack();
    await page.waitForURL((u) => u.search.includes("month=2026-10"));
    await page.waitForFunction(() => document.querySelector("#sf-h ~ p[role=status]")?.textContent?.includes("October"));
    check("browser back restores the month filter", (await complexRows(page)) === 10, String(await complexRows(page)));
    await page.goForward();
    await page.waitForURL((u) => u.search === "?category=Groceries");
    await page.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="sp-tx"] [data-txn]').length === 17);
    check("and forward again", true);

    await page.getByRole("link", { name: "Clear filters" }).click();
    await page.waitForURL((u) => u.search === "");
    await page.waitForFunction(() => !document.querySelector("#sf-h"));
    check("Clear filters shows everything again", (await complexRows(page)) > 60, String(await complexRows(page)));

    await go(page, `${SPENDING}?merchant=tesco&month=2026-10`);
    check("merchant filter matches Tesco exactly", (await complexRows(page)) === 5 && (await status(page)).startsWith("Showing Tesco in October: 5 purchases"), await status(page));

    await go(page, `${SPENDING}?category=Travel&month=2026-09`);
    check("empty state says what was looked for", (await page.locator("main").innerText()).includes("No Travel purchases in September."));

    await go(page, `${SPENDING}?month=2026-11&sort=highest`);
    check("partial month says so", (await page.locator("#sp-total").innerText()).includes("(8 days)") && (await page.locator("main").innerText()).includes("November so far: 8 days"));
    const first = await page.locator('section[aria-labelledby="sp-tx"] [data-txn]').first().innerText();
    check("sort from the URL applies (highest first: Trainline £64.30)", first.includes("Trainline") && first.includes("£64.30"), first);
    check("sort select starts at the URL's value", (await page.getByLabel("Sort").inputValue()) === "highest");
    await page.context().close();
  }

  console.log("\nOpening one transaction");
  {
    const page = await open();
    await go(page, `${SPENDING}?txn=t051`);
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-txn-detail") === "t051");
    check("?txn opens and focuses the detail panel", (await activeInfo(page)).txn === "t051");
    check("the row is scrolled into view", await inViewport(page, '[data-txn="t051"]'));
    const detail = await page.locator('[data-txn-detail="t051"]').innerText();
    check("detail shows merchant, date, amount, category, status", ["Tesco", "Thursday 5 November", "£38.62", "Groceries", "Posted"].every((s) => detail.includes(s)), detail);
    check("and the possible duplicate", detail.includes("Possible duplicate") && detail.includes("6 Nov"));
    await axe(page, "Spending, transaction open");
    await page.getByRole("link", { name: "Close transaction details" }).click();
    await page.waitForURL((u) => u.search === "");
    await page.waitForFunction(() => !document.querySelector("[data-txn-detail]"));
    check("Close removes ?txn and returns focus to the row", (await page.evaluate(() => document.activeElement?.getAttribute("data-txn"))) === "t051");

    await go(page, `${SPENDING}?txn=t999`);
    check("unknown transaction: polite message", (await page.locator("main").innerText()).includes("That transaction isn't on this account."));
    check("no crash", (await page.locator("h1").innerText()) === "Spending");

    await go(page, `${SPENDING}?category=Groceries&txn=t002`);
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-txn-detail") === "t002");
    check("a transaction outside the filters is shown on its own, focused", (await page.locator('[data-txn-detail="t002"]').innerText()).includes("isn't part of Groceries"));

    await go(page, `${SPENDING}?highlight=t051,t052`);
    check("?highlight still works", (await page.locator("main").innerText()).includes("Showing 2 transactions from your question") && (await page.locator("[data-highlighted]").count()) === 2);
    check("Clear highlight goes back to all spending", (await page.getByRole("link", { name: "Clear highlight" }).getAttribute("href")) === "/account/spending");

    await go(page, `${SPENDING}?txn=t048`);
    check("price change is described", (await page.locator('[data-txn-detail="t048"]').innerText()).includes("Price up £2.00"));
    await page.context().close();
  }

  console.log("\nSimple view");
  {
    const page = await open({ mode: "simple" });
    await go(page, `${SPENDING}?category=Groceries&month=2026-10`);
    check("Simple shows the same filter bar", (await status(page)) === "Showing Groceries in October: 10 purchases, £318.30");
    check("and the 10 purchases", (await simpleRows(page)) === 10, String(await simpleRows(page)));
    await axe(page, "Spending, filtered, Simple");
    await go(page, `${SPENDING}?category=Travel&month=2026-09`);
    check("Simple empty state", (await page.locator("main").innerText()).includes("No Travel purchases in September."));
    await go(page, `${SPENDING}?txn=t051`);
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-txn-detail") === "t051");
    check("Simple ?txn focuses the detail", true);
    await page.context().close();
  }

  console.log("\nHome ?focus=");
  {
    const page = await open();
    await go(page, `${HOME}?focus=balance`);
    await page.waitForFunction(() => document.activeElement?.id === "w-balance");
    check("?focus=balance focuses the balance heading", (await activeInfo(page)).id === "w-balance");
    check("and emphasises it", (await page.locator('[data-widget="balance"][data-focused]').count()) === 1);

    await go(page, SPENDING);
    await page.evaluate(() => window.next.router.push("/account?focus=recent"));
    await page.waitForURL((u) => u.pathname === "/account");
    await page.waitForFunction(() => document.activeElement?.id === "w-recent", null, { timeout: 5000 });
    check("works after a client-side navigation", (await activeInfo(page)).id === "w-recent");
    check("recent is scrolled into view", await inViewport(page, "#w-recent"));
    await page.evaluate(() => window.next.router.push("/account?focus=bill"));
    await page.waitForFunction(() => document.activeElement?.id === "w-bill", null, { timeout: 5000 });
    check("and when only the section changes", true);

    await go(page, `${HOME}?focus=nonsense`);
    check("an unknown section is ignored", (await page.locator("main").innerText()).includes("Current balance"));
    await page.context().close();

    const simple = await open({ mode: "simple" });
    await go(simple, `${HOME}?focus=balance`);
    const text = await simple.locator("main").innerText();
    check("a hidden section says so, with a link to Settings", text.includes("Your balance and credit section is hidden on Home.") && (await simple.getByRole("link", { name: "Show it in Settings" }).count()) === 1);
    check("the notice is focused", (await activeInfo(simple)).text.includes("hidden on Home"));
    await axe(simple, "Home, hidden section notice");
    await simple.context().close();

    const reduced = await open({ reducedMotion: "reduce" });
    await go(reduced, `${HOME}?focus=budget`);
    await reduced.waitForFunction(() => document.activeElement?.id === "w-budget");
    const ring = reduced.locator('[data-widget="budget"][data-focused] > span[aria-hidden]');
    check("reduced motion: static emphasis ring, no animation", (await ring.count()) === 1 && !(await ring.getAttribute("class")).includes("animate"));
    await reduced.context().close();
  }

  console.log("\n320px, 200% text, high contrast, dark");
  {
    const page = await open({ viewport: NARROW, prefs: { textSize: 200 } });
    for (const url of [`${SPENDING}?category=Groceries&month=2026-10&sort=highest`, `${SPENDING}?merchant=Sainsbury's&txn=t057`, `${SPENDING}?txn=t999`, `${HOME}?focus=recent`]) {
      await go(page, url);
      check(`no horizontal scroll at 320px, 200% text: ${url.replace(BASE, "")}`, await fits(page));
    }
    await page.context().close();
    const simple = await open({ mode: "simple", viewport: NARROW, prefs: { textSize: 200 } });
    await go(simple, `${SPENDING}?category=Groceries&month=2026-11&txn=t052`);
    check("no horizontal scroll at 320px, 200% text: Simple, filtered with detail", await fits(simple));
    await simple.context().close();

    const hc = await open({ prefs: { contrast: "high" } });
    await go(hc, `${SPENDING}?category=Shopping&month=2026-10&txn=t036`);
    check("refunds counted separately", (await status(hc)).includes("4 purchases and 1 refund"), await status(hc));
    await axe(hc, "Spending, high contrast");
    await hc.context().close();
    const dark = await open({ prefs: { theme: "dark" } });
    await go(dark, `${SPENDING}?category=Groceries&month=2026-11&txn=t051`);
    await axe(dark, "Spending, dark theme");
    await go(dark, `${HOME}?focus=insights`);
    await axe(dark, "Home focus, dark theme");
    await dark.context().close();
  }

  check("no console errors", problems.length === 0, problems.join(" | "));
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
