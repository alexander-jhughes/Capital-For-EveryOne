// Browser test of the account API and session cookie, against the production build, with Chromium through Playwright.
// Usage: npm run build, then node scripts/test-backend-browser.mjs. Starts `next start` on port 3500 and stops it after.
// `next start` runs in production mode, which refuses to sign sessions without SESSION_SECRET, so one is set here if missing.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORT = 3500;
const BASE = `http://localhost:${PORT}`;
const SEED_BALANCE = 106989;
const PAYMENT = 5000;
const PURCHASE = 12000;
const gbp = (pence) => `£${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let failures = 0;
const check = (name, passed, detail = "") => {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed || !detail ? "" : `\n      ${detail}`}`);
};

const server = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], {
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", SESSION_SECRET: process.env.SESSION_SECRET || "browser-test-secret-that-is-long-enough" },
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

async function open() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([{ name: "cfe-mode", value: "complex", domain: "localhost", path: "/" }]);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) problems.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
  return page;
}

const main = (page) => page.locator("main").innerText();
const api = async (page, path = "/api/account") => (await page.context().request.get(`${BASE}${path}`)).json();
const sessionCookie = async (page) => (await page.context().cookies()).find((c) => c.name === "cfe-session");
/** Waits for the next change to reach the server, so a reload straight after sees it. */
const settled = (page, method, path) => page.waitForResponse((r) => r.request().method() === method && new URL(r.url()).pathname.startsWith(path));

try {
  const page = await open();

  console.log("\nStarting point");
  const seed = await api(page);
  check("GET /api/account starts from the seed", seed.account.currentBalance === SEED_BALANCE && seed.payments.length === 0 && seed.saved === true);
  check("a visitor who has changed nothing has no session cookie", (await sessionCookie(page)) === undefined);

  console.log("\nPay");
  await page.goto(`${BASE}/account/pay`);
  await page.getByRole("button", { name: "Review payment" }).waitFor();
  check("the Pay screen shows the seed balance", (await main(page)).includes(gbp(SEED_BALANCE)));
  await page.getByRole("radio", { name: "Other amount" }).check();
  await page.getByLabel("Amount in pounds").fill("50");
  await page.getByRole("button", { name: "Review payment" }).click();
  const posted = settled(page, "POST", "/api/payments");
  await page.getByRole("button", { name: "Confirm payment" }).click();
  await page.getByRole("heading", { name: "Payment recorded" }).waitFor();
  check("the payment is recorded at once", (await main(page)).includes(gbp(SEED_BALANCE - PAYMENT)));
  check("the server accepted it", (await posted).status() === 200);
  await page.reload();
  await page.getByRole("button", { name: "Review payment" }).waitFor();
  const afterReload = await main(page);
  check("after a reload the payment is still there", afterReload.includes(`${gbp(PAYMENT)} on`) && (await page.getByRole("button", { name: `Undo ${gbp(PAYMENT)} payment` }).isVisible()));
  check("and the balance is right", afterReload.includes(gbp(SEED_BALANCE - PAYMENT)), afterReload.slice(0, 300));
  const paid = await api(page);
  check("GET /api/account agrees", paid.account.currentBalance === SEED_BALANCE - PAYMENT && paid.payments.length === 1 && paid.account.statementBalance === 48620 - PAYMENT);

  const cookie = await sessionCookie(page);
  check("the session cookie is HttpOnly and SameSite=Lax", cookie?.httpOnly === true && cookie?.sameSite === "Lax", JSON.stringify(cookie));
  check("and under 3.5 KB", (cookie?.value.length ?? 9999) < 3584, `${cookie?.value.length} bytes`);

  console.log("\nSpend Pause");
  await page.goto(`${BASE}/account/spend-pause`);
  await page.getByRole("heading", { name: "Spend Pause is off" }).waitFor();
  await page.getByRole("button", { name: "Change what's checked" }).click();
  await page.getByLabel("Another amount").check();
  await page.getByLabel("Amount in pounds").fill("75.50");
  const savedChoices = settled(page, "PUT", "/api/spend-pause");
  await page.getByRole("button", { name: "Save choices" }).click();
  await page.getByText("Your Spend Pause choices are saved.").waitFor();
  check("choices reach the server", (await savedChoices).status() === 200);
  const turnedOn = settled(page, "PUT", "/api/spend-pause");
  await page.getByRole("button", { name: "Turn on Spend Pause" }).click();
  await page.getByRole("button", { name: "Yes, turn it on" }).click();
  await page.getByRole("heading", { name: "Spend Pause is on" }).waitFor();
  check("turning it on reaches the server", (await turnedOn).status() === 200);
  await page.reload();
  await page.getByRole("heading", { name: "Spend Pause is on" }).waitFor();
  const pauseText = await main(page);
  check("after a reload Spend Pause is still on with the saved threshold", pauseText.includes("Any purchase over £75.50"), pauseText.slice(0, 300));
  check("and says since when", pauseText.includes("On since"));
  const settings = (await api(page)).settings;
  check("GET /api/account agrees", settings.enabled === true && settings.singlePurchaseThreshold === 7550);

  console.log("\nDemo shop through Spend Pause");
  await page.goto(`${BASE}/demo/shop`);
  await page.getByRole("button", { name: "Buy" }).click();
  await page.getByRole("button", { name: "Go ahead" }).waitFor();
  const bought = settled(page, "POST", "/api/purchases");
  await page.getByRole("button", { name: "Go ahead" }).click();
  await page.getByRole("heading", { name: "Purchase made" }).waitFor();
  check("an approved purchase reaches the server", (await bought).status() === 200);
  await page.goto(`${BASE}/account/pay`);
  await page.getByRole("button", { name: "Review payment" }).waitFor();
  check("the balance includes the purchase after a reload", (await main(page)).includes(gbp(SEED_BALANCE - PAYMENT + PURCHASE)));

  console.log("\nGoals");
  await page.goto(`${BASE}/account/goals`);
  await page.getByRole("button", { name: "Add a goal" }).click();
  await page.locator("#goal-amount").fill("80");
  const goalSaved = settled(page, "PUT", "/api/goals");
  await page.getByRole("button", { name: "Add this goal" }).click();
  await page.getByRole("heading", { name: "Your goals (1)" }).waitFor();
  check("the goal reaches the server", (await goalSaved).status() === 200);
  await page.reload();
  await page.getByRole("heading", { name: "Your goals (1)" }).waitFor();
  check("after a reload the goal is still there", /eating out/i.test(await main(page)));
  const goals = (await api(page, "/api/goals")).goals;
  check("GET /api/goals agrees", goals.length === 1 && goals[0].spec.kind === "category_cap" && goals[0].spec.monthlyLimit === 8000);

  console.log("\nThe cookie is the only thing the server trusts");
  const signed = (await sessionCookie(page)).value;
  const flipped = signed.slice(0, 10) + (signed[10] === "A" ? "B" : "A") + signed.slice(11);
  const forged = await (await fetch(`${BASE}/api/account`, { headers: { cookie: `cfe-session=${flipped}` } })).json();
  check("a cookie with one byte changed is ignored: the seed comes back", forged.account.currentBalance === SEED_BALANCE && forged.payments.length === 0);
  const garbage = await (await fetch(`${BASE}/api/account`, { headers: { cookie: "cfe-session=not-a-session" } })).json();
  check("so is garbage", garbage.account.currentBalance === SEED_BALANCE);
  const liar = { payments: [{ id: "pay-liar", date: "2026-11-08", amount: 60000 }] };
  const askWith = await (await fetch(`${BASE}/api/ask`, { method: "POST", headers: { "content-type": "application/json", cookie: `cfe-session=${signed}` }, body: JSON.stringify({ question: "What's my current balance?", state: liar }) })).json();
  const balanceNow = SEED_BALANCE - PAYMENT + PURCHASE;
  // The wording is chosen from several templates; the figure is what matters.
  check("/api/ask answers from the cookie and ignores the body's state", askWith.answer.includes(gbp(balanceNow)) && !askWith.answer.includes(gbp(SEED_BALANCE - 60000)), askWith.answer);
  const askWithout = await (await fetch(`${BASE}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "What's my current balance?", state: liar }) })).json();
  check("without a cookie the body's state still counts, as before", askWithout.answer.includes(gbp(SEED_BALANCE - 60000)), askWithout.answer);
  const refused = await fetch(`${BASE}/api/payments`, { method: "POST", headers: { "content-type": "application/json", cookie: `cfe-session=${signed}` }, body: JSON.stringify({ id: "pay-too-much", amount: balanceNow + 1, kind: "custom" }) });
  check("a payment above the balance is refused with a friendly error", refused.status === 400 && (await refused.json()).error.includes("more than your current balance"));

  console.log("\nUndo");
  await page.goto(`${BASE}/account/pay`);
  await page.getByRole("button", { name: "Review payment" }).waitFor();
  const undone = settled(page, "DELETE", "/api/payments/");
  await page.getByRole("button", { name: `Undo ${gbp(PAYMENT)} payment` }).click();
  check("the undo reaches the server", (await undone).status() === 200);
  await page.reload();
  await page.getByRole("button", { name: "Review payment" }).waitFor();
  check("after a reload the payment is gone and the balance is back", (await main(page)).includes(gbp(SEED_BALANCE + PURCHASE)) && !(await page.getByRole("button", { name: `Undo ${gbp(PAYMENT)} payment` }).isVisible()));

  console.log("\nA second browser, with no cookie");
  const other = await open();
  await other.goto(`${BASE}/account/pay`);
  await other.getByRole("button", { name: "Review payment" }).waitFor();
  check("starts from the seed balance", (await main(other)).includes(gbp(SEED_BALANCE)));
  await other.goto(`${BASE}/account/spend-pause`);
  await other.getByRole("heading", { name: "Spend Pause is off" }).waitFor();
  check("with Spend Pause off", true);
  await other.goto(`${BASE}/account/goals`);
  await other.getByRole("heading", { name: "You don't have any goals yet" }).waitFor();
  check("and no goals", true);
  check("and still no session cookie", (await sessionCookie(other)) === undefined);

  check("no console or page errors", problems.length === 0, problems.join("\n      "));
} finally {
  await browser.close();
  stop();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
