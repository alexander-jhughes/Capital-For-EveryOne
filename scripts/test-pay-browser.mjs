// Browser tests for Pay, against the production build, using installed Chrome.
// Usage: npm run build, then npm run test:pay. Adds no project dependency: npm exec fetches the tools.
// Set SHOTS=<folder> to save screenshots.

import { execSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const toolsDir = dirname(realpathSync(execSync("command -v playwright-core", { shell: "/bin/sh" }).toString().trim()));
const { chromium } = await import(join(toolsDir, "index.mjs"));
const axeSource = readFileSync(createRequire(join(toolsDir, "index.js")).resolve("axe-core"), "utf8");

const PORT = 3215;
const BASE = `http://localhost:${PORT}`;
const HOME = `${BASE}/account`;
const PAY = `${BASE}/account/pay`;
const SPENDING = `${BASE}/account/spending`;
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
    await fetch(PAY);
    break;
  } catch (error) {
    if (attempt > 100) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const problems = [];

async function open({ mode = "complex", viewport = PHONE, prefs, init } = {}) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([
    { name: "cfe-mode", value: mode, domain: "localhost", path: "/" },
    ...(prefs ? [{ name: "cfe-prefs", value: encodeURIComponent(JSON.stringify(prefs)), domain: "localhost", path: "/" }] : []),
  ]);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) problems.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
  return page;
}

const main = (page) => page.locator("main").innerText();
const has = async (page, text) => (await main(page)).includes(text);
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const setMode = (page, value) => page.context().addCookies([{ name: "cfe-mode", value, domain: "localhost", path: "/" }]);
const payReady = (page) => page.getByRole("button", { name: "Review payment" }).waitFor();
const openPay = async (page) => {
  await page.goto(PAY);
  await payReady(page);
};
const pickOption = (page, name) => page.getByRole("radio", { name }).check();
const review = (page) => page.getByRole("button", { name: "Review payment" }).click();
const confirm = async (page) => {
  await page.getByRole("button", { name: "Confirm payment" }).click();
  await page.getByRole("heading", { name: "Payment recorded" }).waitFor();
};
const payOther = async (page, amount) => {
  await openPay(page);
  await pickOption(page, "Other amount");
  await page.getByLabel("Amount in pounds").fill(amount);
  await review(page);
  await confirm(page);
};
const shot = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};
async function axe(page, label) {
  await page.waitForTimeout(500); // colours are only final once the page transition ends
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.addScriptTag({ content: axeSource });
  const found = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] });
    return result.violations.map((v) => `${v.id}: ${v.nodes[0].html.slice(0, 90)} ${v.nodes[0].failureSummary?.replace(/\s+/g, " ").slice(0, 240)}`);
  });
  check(`axe: ${label}`, found.length === 0, found.join(" ; "));
}
const spendingTotal = async (page) => {
  await page.goto(SPENDING);
  await page.getByText(/£402\.35|spent/i).first().waitFor();
  return (await main(page)).includes("£402.35");
};

try {
  for (const mode of ["complex", "simple"]) {
    console.log(`\n${mode} mode`);
    const page = await open({ mode });
    await openPay(page);
    const text = await main(page);
    check("shows the statement balance", text.includes("£486.20"));
    check("shows the current balance", text.includes("£1,069.89"));
    check("shows the minimum payment", text.includes("£25.00"));
    check("shows the due date", text.includes("13 November"));
    check("doesn't say the statement clears everything", text.includes("£583.69 would stay on your balance"));
    check("says it is simulated before paying", text.includes("No real money moves"));
    await shot(page, `${mode}-choose`);
    await axe(page, `${mode} choose`);

    await pickOption(page, /Statement balance/);
    await review(page);
    await page.getByRole("button", { name: "Confirm payment" }).waitFor();
    const summary = await main(page);
    check("review shows the amount, the card and the balance after", summary.includes("£486.20") && summary.includes("Card ending 4417") && summary.includes("£583.69"));
    check("review says no real money moves", summary.includes("No real money moves"));
    check("nothing is paid at review", (await page.evaluate(() => sessionStorage.getItem("cfe-payments-session"))) === null);
    await shot(page, `${mode}-review`);
    await axe(page, `${mode} review`);

    await page.getByRole("button", { name: "Go back" }).click();
    await payReady(page);
    check("going back pays nothing", await has(page, "£1,069.89"));

    await pickOption(page, /Statement balance/);
    await review(page);
    await confirm(page);
    const done = await main(page);
    check("success states the new balance", done.includes("£583.69") && done.includes("£0.00"));
    check("success says it was simulated", done.includes("No real money moved"));
    check("focus moves to the result", (await page.evaluate(() => document.activeElement?.textContent)).includes("Payment recorded"));
    await shot(page, `${mode}-done`);
    await axe(page, `${mode} done`);

    await page.goto(HOME);
    await page.getByText(/Your bill is paid/).first().waitFor();
    check("Home shows the bill is paid", true);
    check("Home no longer asks for £0.00", !(await has(page, "The least you can pay is £0.00")) && !(await has(page, "Pay my bill")));
    await shot(page, `${mode}-home-paid`);
    await axe(page, `${mode} Home with the bill paid`);

    check("purchase spending stays £402.35", await spendingTotal(page));
    await setMode(page, "complex");
    await page.goto(SPENDING);
    await page.getByText("Payment received").first().waitFor();
    const rows = await main(page);
    check("the payment is in the transaction history", rows.includes("+£486.20"));
    check("it is marked as a pending payment", /Payment received[\s\S]{0,60}Pending/.test(rows));
    await setMode(page, mode);

    await page.reload();
    await openPay(page);
    check("a refresh keeps the payment", (await main(page)).includes("£583.69"));
    check("payment history shows it", (await main(page)).includes("Payment history") && (await main(page)).includes("£486.20"));
    check("the bill option has gone at £0", (await page.getByRole("radio", { name: /Statement balance/ }).count()) === 0);
    check("only sensible options are left", (await page.locator("main").getByRole("radio").count()) === 2);
    await page.getByRole("button", { name: /^Undo £486\.20/ }).click();
    await page.getByText("Your balance is back to £1,069.89").waitFor();
    check("undo restores the balance", await has(page, "£1,069.89"));
    check("undo restores the bill", await has(page, "£486.20"));
    check("undo removes it from history", (await page.getByRole("button", { name: /^Undo/ }).count()) === 0);
    await page.goto(SPENDING);
    await page.reload();
    check("undo removes it from transactions, and stays undone after a refresh", !(await has(page, "+£486.20")));
    await page.context().close();
  }

  console.log("\nValidation");
  {
    const page = await open();
    await openPay(page);
    await pickOption(page, "Other amount");
    const field = page.getByLabel("Amount in pounds");
    for (const [input, message] of [
      ["", "Enter an amount"],
      ["0", "above £0"],
      ["-10", "above £0"],
      ["abc", "numbers only"],
      ["1e3", "numbers only"],
      ["12.345", "2 decimal places"],
      ["1069.90", "current balance of £1,069.89"],
    ]) {
      await field.fill(input);
      await review(page);
      const alert = page.getByRole("alert").filter({ hasText: message });
      await alert.waitFor();
      check(`refuses ${JSON.stringify(input)}`, (await page.getByRole("button", { name: "Confirm payment" }).count()) === 0);
      check(`the field is marked and described for ${JSON.stringify(input)}`, (await field.getAttribute("aria-invalid")) === "true" && (await field.getAttribute("aria-describedby")).includes((await alert.getAttribute("id"))));
      check(`focus returns to the field for ${JSON.stringify(input)}`, await field.evaluate((el) => document.activeElement === el));
    }
    await shot(page, "validation");
    await axe(page, "validation error");
    await field.fill("10.5");
    check("the error clears when typing", (await page.getByRole("alert").filter({ hasText: "current balance" }).count()) === 0);
    await field.press("Enter");
    await page.getByRole("button", { name: "Confirm payment" }).waitFor();
    check("Enter reviews a valid amount", await has(page, "£10.50"));
    check("warns below the minimum", await has(page, "less than your £25.00 minimum"));
    await page.context().close();
  }

  console.log("\nDuplicates");
  {
    const page = await open();
    await openPay(page);
    await pickOption(page, /Minimum payment/);
    await review(page);
    await page.getByRole("button", { name: "Confirm payment" }).evaluate((button) => {
      button.click();
      button.click();
      button.click();
    });
    await page.getByRole("heading", { name: "Payment recorded" }).waitFor();
    const saved = JSON.parse(await page.evaluate(() => sessionStorage.getItem("cfe-payments-session")));
    check("rapid clicks pay once", saved.length === 1 && saved[0].amount === 2500, JSON.stringify(saved));
    await page.reload();
    await payReady(page);
    check("a refresh after paying doesn't pay again", (await main(page)).includes("£1,044.89"));
    await page.context().close();
  }
  {
    const page = await open();
    await openPay(page);
    await pickOption(page, /Minimum payment/);
    await review(page);
    await page.getByRole("button", { name: "Confirm payment" }).dblclick();
    await page.getByRole("heading", { name: "Payment recorded" }).waitFor();
    check("a double click pays once", (await main(page)).includes("£1,044.89"));
    await page.context().close();
  }

  console.log("\nPartial, several and full payments");
  {
    const page = await open();
    await payOther(page, "100");
    check("partial payment", (await main(page)).includes("£969.89") && (await main(page)).includes("£386.20"));
    await payOther(page, "50.25");
    check("a second payment adds up", (await main(page)).includes("£919.64") && (await main(page)).includes("£335.95"));
    await openPay(page);
    check("history keeps both, with unique undo buttons", (await page.getByRole("button", { name: /^Undo/ }).count()) === 2);
    await page.getByRole("button", { name: /^Undo £100\.00/ }).click();
    await page.getByText("Your balance is back to £1,019.64").waitFor();
    check("undoing an earlier payment keeps the later one", (await main(page)).includes("£1,019.64"));
    await page.context().close();
  }
  {
    const page = await open();
    await openPay(page);
    await pickOption(page, /Full current balance/);
    await review(page);
    await confirm(page);
    check("full balance payment reaches £0", (await main(page)).includes("£0.00"));
    check("no further payment is offered", (await page.getByRole("button", { name: "Make another payment" }).count()) === 0);
    await page.goto(PAY);
    await page.getByText("You have nothing to pay.").waitFor();
    check("Pay says there is nothing to pay at £0", (await page.getByRole("button", { name: "Review payment" }).count()) === 0);
    await shot(page, "nothing-to-pay");
    await axe(page, "nothing to pay");
    check("spending is still £402.35", await spendingTotal(page));
    await page.context().close();
  }

  console.log("\nSimple and Detailed agree");
  {
    const page = await open({ mode: "simple" });
    await payOther(page, "100");
    for (const m of ["simple", "complex"]) {
      await setMode(page, m);
      await openPay(page);
      const text = await main(page);
      check(`${m}: the same figures`, text.includes("£969.89") && text.includes("£386.20") && text.includes("£25.00"));
    }
    await page.context().close();
  }

  console.log("\nStorage trouble");
  {
    const page = await open({
      init: () => {
        Object.defineProperty(window, "sessionStorage", {
          get() {
            throw new Error("blocked");
          },
        });
      },
    });
    await payOther(page, "20");
    check("works with storage blocked, and says so", (await main(page)).includes("can't save on this device"));
    await page.context().close();
  }
  for (const [label, value] of [
    ["broken JSON", "{oops"],
    ["a seed id", '[{"id":"t001","amount":100,"date":"2026-11-08","kind":"custom"}]'],
    ["more than is owed", '[{"id":"pay-1","amount":999999,"date":"2026-11-08","kind":"custom"}]'],
  ]) {
    const page = await open({ init: `sessionStorage.setItem("cfe-payments-session", ${JSON.stringify(value)})` });
    await openPay(page);
    check(`${label} falls back to the demo account`, (await main(page)).includes("£1,069.89"));
    await page.context().close();
  }

  console.log("\nKeyboard only");
  {
    const page = await open();
    await openPay(page);
    await page.getByRole("radio", { name: /Statement balance/ }).focus();
    await page.keyboard.press("ArrowDown");
    check("arrow keys move between amounts", await page.getByRole("radio", { name: /Minimum payment/ }).isChecked());
    await page.getByRole("button", { name: "Review payment" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Confirm payment" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Payment recorded" }).waitFor();
    check("pays by keyboard alone", true);
    await page.context().close();
  }

  console.log("\nLayouts and preferences");
  for (const [label, viewport, prefs] of [
    ["320px", { width: 320, height: 640 }],
    ["390px", PHONE],
    ["768px", { width: 768, height: 1024 }],
    ["desktop", DESKTOP],
    ["200% text at 320px", { width: 320, height: 640 }, { textSize: 200 }],
    ["high contrast", PHONE, { contrast: "high" }],
    ["dark", PHONE, { theme: "dark" }],
    ["dark high contrast", PHONE, { theme: "dark", contrast: "high" }],
    ["bigger buttons", PHONE, { targets: "large" }],
  ]) {
    for (const mode of ["complex", "simple"]) {
      const page = await open({ mode, viewport, prefs });
      await openPay(page);
      if (prefs?.textSize) check(`${label}, ${mode}: the text size really applied`, (await page.evaluate(() => document.documentElement.dataset.text)) === "200");
      const choose = await fits(page);
      await pickOption(page, "Other amount");
      await page.getByLabel("Amount in pounds").fill("abc");
      await review(page);
      await page.getByRole("alert").filter({ hasText: "numbers only" }).waitFor();
      const error = await fits(page);
      await page.getByLabel("Amount in pounds").fill("100");
      await review(page);
      await page.getByRole("button", { name: "Confirm payment" }).waitFor();
      const reviewing = await fits(page);
      await confirm(page);
      const done = await fits(page);
      check(`${label}, ${mode}: no sideways scroll`, choose && error && reviewing && done);
      if (prefs) await axe(page, `${label}, ${mode}`);
      await page.context().close();
    }
  }
  {
    const page = await open({ prefs: { textSize: 200, explanations: "stepByStep" } });
    await openPay(page);
    check("step-by-step explanations are respected", (await page.locator("main ol li").count()) === 3);
    await page.goto(`${BASE}/account/settings`);
    const cookie = (await page.context().cookies()).find((c) => c.name === "cfe-prefs");
    check("Pay leaves preferences alone", decodeURIComponent(cookie?.value ?? "").includes("stepByStep"));
    await page.context().close();
  }

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
