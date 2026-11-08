// Browser test of the synthetic demo users and profile tailoring, against the production build, with Chromium through
// Playwright. Usage: npm run build, then npm run test:demo-users. Starts `next start` on port 3510 and stops it after.
// Checks: all 18 users in one tab (right type, only their own events, Home shows the server's balance, nothing left in
// browser storage), refresh, a separate browser, the pending-purchase carry-over, low confidence, and cross-site posts.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORT = 3510;
const BASE = `http://localhost:${PORT}`;
const SEED_BALANCE = 106989;
// How each synthetic user was written (lib/demo-users/users.ts). The model isn't told this; it agrees for all 18.
const USERS = {
  amara: "building", jonah: "building", mei: "building",
  priya: "steady", tom: "steady", grace: "steady",
  dan: "stretched", leah: "stretched", kofi: "stretched",
  ruth: "life_change", sam: "life_change", ella: "life_change",
  arthur: "clear_simple", nadia: "clear_simple", joe: "clear_simple",
  ivy: "planner", raj: "planner", zoe: "planner",
};
const gbp = (pence) => `£${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let failures = 0;
let passes = 0;
const check = (name, passed, detail = "") => {
  if (passed) passes += 1;
  else failures += 1;
  if (!passed || process.env.VERBOSE) console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed || !detail ? "" : `\n      ${detail}`}`);
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
    await fetch(`${BASE}/api/profile`);
    break;
  } catch (error) {
    if (attempt > 150) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
const problems = [];
async function open({ watchErrors = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  if (!watchErrors) return page;
  page.on("console", (m) => m.type() === "error" && !m.text().includes("favicon") && problems.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
  return page;
}
const api = async (page, path) => (await page.context().request.get(`${BASE}${path}`)).json();
/**
 * Anything in this tab's storage that isn't this user's. Home writes a fresh Spend Pause record as soon as it loads, so
 * that one is read: no pending purchase, no history, and only this user's purchases. Any other app key is a leftover.
 */
const leftovers = (page, id) =>
  page.evaluate((id) => {
    const found = [];
    for (const store of [sessionStorage, localStorage]) {
      for (const k of Object.keys(store).filter((k) => k.startsWith("cfe-") && k !== "cfe-profile-offer")) {
        if (k !== "cfe-spend-pause-session") {
          found.push(k);
          continue;
        }
        const s = JSON.parse(store.getItem(k));
        if (s.pendingPurchase !== null) found.push(`pending purchase ${s.pendingPurchase.id}`);
        if (s.history.length) found.push(`${s.history.length} Spend Pause history records`);
        for (const p of s.purchases) if (!p.id.startsWith(`demo-${id}-`)) found.push(`purchase ${p.id}`);
      }
    }
    return found;
  }, id);
const showsBalance = async (page, pence) => {
  try {
    await page.locator("main").getByText(gbp(pence)).first().waitFor({ timeout: 8000 });
    return true;
  } catch {
    return false;
  }
};
async function become(page, id) {
  await page.goto(`${BASE}/demo/users`);
  await page.getByRole("button", { name: new RegExp(`^${id}`, "i") }).click();
  await page.waitForURL(`${BASE}/account`);
  await page.locator("[data-person-type]").waitFor({ timeout: 10_000 });
}

try {
  // ---- All 18 in one tab, in order, then refresh ----
  const page = await open();
  for (const [id, type] of Object.entries(USERS)) {
    await become(page, id);
    check(`${id}: Home tailored as ${type}`, (await page.locator("[data-person-type]").getAttribute("data-person-type")) === type);
    const state = await api(page, "/api/account");
    const ids = [...state.payments, ...state.purchases, ...state.goals].map((e) => e.id);
    check(`${id}: only their own events`, ids.every((x) => x.startsWith(`demo-${id}-`)), ids.join());
    check(`${id}: nothing of anyone else's in browser storage`, (await leftovers(page, id)).length === 0, (await leftovers(page, id)).join());
    check(`${id}: Home shows the server's balance`, await showsBalance(page, state.account.currentBalance), gbp(state.account.currentBalance));
    const profile = await api(page, "/api/profile");
    check(`${id}: profile is theirs`, profile.consent && profile.result?.type === type, JSON.stringify(profile.result?.type));
    await page.reload();
    await page.locator("[data-person-type]").waitFor();
    check(`${id}: same after a refresh`, (await page.locator("[data-person-type]").getAttribute("data-person-type")) === type && (await showsBalance(page, state.account.currentBalance)));
  }

  // ---- Separate browser: sees none of it ----
  const other = await open();
  await other.goto(`${BASE}/account`);
  const otherState = await api(other, "/api/account");
  const otherProfile = await api(other, "/api/profile");
  check("a separate browser has the untouched demo account", otherState.account.currentBalance === SEED_BALANCE && otherState.payments.length === 0 && otherState.goals.length === 0);
  check("a separate browser has no profile", otherProfile.consent === false && otherProfile.result === null);
  check("a separate browser shows no tailored card", (await other.locator("[data-person-type]").count()) === 0);

  // ---- Dan's pending Spend Pause purchase must not follow into Ruth ----
  await become(page, "dan");
  await page.goto(`${BASE}/demo/shop`);
  await page.getByRole("button", { name: "Buy" }).first().click();
  await page.waitForURL("**/spend-pause/check");
  check("Dan's purchase is held by Spend Pause", (await leftovers(page, "dan")).some((x) => x.startsWith("pending purchase")));
  await become(page, "ruth");
  check("after switching to Ruth, nothing of Dan's is in this tab", (await leftovers(page, "ruth")).length === 0, (await leftovers(page, "ruth")).join());
  await page.goto(`${BASE}/account/spend-pause`);
  await page.locator("main").getByText("Spend Pause").first().waitFor();
  check("Ruth has no purchase waiting", !(await page.locator("main").innerText()).includes("A purchase is waiting"));
  const ruth = await api(page, "/api/account");
  check("Ruth's account has no purchases or payments", ruth.purchases.length === 0 && ruth.payments.length === 0 && ruth.account.currentBalance === SEED_BALANCE);

  // ---- Low confidence: nothing told, nothing done ----
  const fresh = await open();
  await fresh.goto(`${BASE}/account/about-you`);
  await fresh.getByRole("button", { name: "Turn on tailoring" }).click();
  await fresh.getByText("Tailoring is on").waitFor();
  check("low confidence asks instead of guessing", await fresh.getByText("Dial isn't sure yet, so it isn't guessing").isVisible());
  await fresh.goto(`${BASE}/account`);
  await fresh.waitForTimeout(1500);
  check("low confidence shows no tailored card", (await fresh.locator("[data-person-type]").count()) === 0);

  // ---- A form on another site can't swap anyone's demo data ----
  // The refused post logs a 403 in this page's console, which is the point, so its console isn't watched.
  const attacker = await open({ watchErrors: false });
  await attacker.goto(`${BASE}/account`);
  // The attacker's page is served from another site; Playwright answers for http://evil.test itself.
  await attacker.route("http://evil.test/**", (route) => route.fulfill({ contentType: "text/html", body: `<form method="post" action="${BASE}/demo/user/dan"><button>go</button></form>` }));
  await attacker.goto("http://evil.test/");
  const posted = attacker.waitForResponse((r) => r.url() === `${BASE}/demo/user/dan`);
  await attacker.click("button");
  const response = await posted;
  check("a cross-site form post is refused", response.status() === 403, String(response.status()));
  check("and changed nothing", (await api(attacker, "/api/profile")).consent === false);

  check("no console errors", problems.length === 0, problems.join("\n      "));
} finally {
  await browser.close();
  stop();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
