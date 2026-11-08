// Browser test of the Dial integration fixes from the product review, against the production build, with Chromium.
// Types each request into the real Dial panel and checks where the app goes and what it shows:
//   A. the Learning Lab, its lessons and More; B. "compare to last month"; C. the categories, upcoming and progress
//   sections on Home, with the account's own data.
// Usage: npm run build, then node scripts/test-dial-fixes-browser.mjs (where Playwright is installed globally), or
// npm exec --yes --package=playwright@1 -- node scripts/test-dial-fixes-browser.mjs. Starts `next start` on port 3520.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORT = 3520;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
let passes = 0;
const check = (name, passed, detail = "") => {
  if (passed) passes += 1;
  else failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed || !detail ? "" : `\n      ${detail}`}`);
};

const server = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], {
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", GROQ_API_KEY: "", SESSION_SECRET: process.env.SESSION_SECRET || "browser-test-secret-that-is-long-enough" },
  stdio: "ignore",
  detached: true,
});
const stop = () => {
  try {
    process.kill(-server.pid);
  } catch {}
};
process.on("exit", stop);
for (let attempt = 0; ; attempt += 1) {
  try {
    await fetch(`${BASE}/api/account`);
    break;
  } catch (error) {
    if (attempt > 150) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
const problems = [];

async function open(mode) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: "cfe-mode", value: mode, domain: "localhost", path: "/" }]);
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && !m.text().includes("favicon") && problems.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
  await page.goto(`${BASE}/account`);
  return page;
}

/** Types a request into the Dial panel, like a person would, and waits for Dial to finish the turn. */
async function ask(page, text) {
  const input = page.getByPlaceholder("Ask or tell Dial anything");
  if (!(await input.isVisible().catch(() => false))) await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /^Dial/ }).click();
  await input.fill(text);
  await input.press("Enter");
  await page.waitForTimeout(1500);
}
const path = (page) => new URL(page.url()).pathname + new URL(page.url()).search;
const widget = (page, id) => page.locator(`[data-widget="${id}"]`);
const reply = (page) => page.locator("dialog section[aria-live]").innerText();

try {
  // ---- A: Learning Lab, lessons, More ----
  console.log("\nTask A: Learning Lab and More");
  const a = await open("complex");
  await ask(a, "Open the Learning Lab.");
  check("Open the Learning Lab. -> /account/learn", path(a) === "/account/learn", path(a));
  check("the Learning Lab page is showing", await a.getByRole("heading", { level: 1 }).first().isVisible());
  await ask(a, "Teach me about credit scores.");
  check("Teach me about credit scores. -> the Learning Lab", path(a) === "/account/learn", path(a));
  check("Dial says it can't see a credit score", (await reply(a)).includes("can't see your credit score"), await reply(a));
  await ask(a, "Teach me about minimum payments");
  check("Teach me about minimum payments -> its lesson", path(a) === "/account/learn/minimum-payments", path(a));
  check("the lesson page shows its title", (await a.locator("main").innerText()).includes("Minimum payments"));
  await ask(a, "Show me more features.");
  check("Show me more features. -> /account/more", path(a) === "/account/more", path(a));
  check("More lists the other screens", (await a.locator("main").innerText()).includes("Goals"));

  // ---- C: sections on Home, with the account's data (Detailed view shows all three) ----
  console.log("\nTask C: Home sections");
  const c = await open("complex");
  const sections = [
    ["Show me my progress.", "progress", /Your progress/, /(No goals yet|Goals)/],
    ["Show my upcoming payments.", "upcoming", /Coming up/, /£\d/],
    // On screen this section is headed "Where it went in <month>" (its name in settings is "Spending by category").
    ["Show my spending categories.", "categories", /Where it went in/, /Groceries[\s\S]*£\d|£\d[\s\S]*Groceries/],
  ];
  for (const [text, id, title, data] of sections) {
    await ask(c, text);
    check(`${text} -> /account?focus=${id}`, path(c) === `/account?focus=${id}`, path(c));
    const box = widget(c, id);
    check(`${id}: the section is on screen`, await box.isVisible());
    const content = await box.innerText();
    check(`${id}: shows its heading`, title.test(content), content.slice(0, 120));
    check(`${id}: shows the account's own data`, data.test(content), content.slice(0, 200));
    check(`${id}: is the focused section`, (await box.getAttribute("data-focused")) !== null || (await c.evaluate((w) => document.activeElement?.closest(`[data-widget="${w}"]`) !== null, id)));
  }
  // The upcoming bill figure is the account's statement balance, not a made-up number.
  const account = await (await c.context().request.get(`${BASE}/api/account`)).json();
  const statement = `£${(account.account.statementBalance / 100).toFixed(2)}`;
  check("Coming up shows the real statement balance", (await widget(c, "upcoming").innerText()).includes(statement), statement);

  // Simple view hides these sections by default: Dial says so and offers to show it, as for other hidden sections.
  const simple = await open("simple");
  await ask(simple, "Show me my progress.");
  check("Simple view: goes to Home with the focus", path(simple) === "/account?focus=progress", path(simple));
  check("Simple view: says the section is hidden and offers to show it", (await simple.locator("main").innerText()).includes("section is hidden on Home"));

  // ---- B: compare to last month ----
  console.log("\nTask B: compare to last month");
  const b = await open("complex");
  await ask(b, "How do my groceries compare to last month?");
  await b.waitForTimeout(1000);
  const said = await reply(b);
  check("compares November with October", said.includes("November and October"), said.slice(0, 300));
  check("November is shown as the days so far, not a whole month", said.includes("1 to 8 November") && said.includes("1 to 8 October"), said.slice(0, 300));
  check("not October against September", !said.includes("October and September"), said.slice(0, 300));

  check("no console errors", problems.length === 0, problems.join("\n      "));
} finally {
  await browser.close();
  stop();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
