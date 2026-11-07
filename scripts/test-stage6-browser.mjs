// Pay and Spend Pause working together, against the production build, using installed Chrome.
// Usage: npm run build, then npm run test:stage6. Adds no project dependency: npm exec fetches the tools.

import { execSync, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const toolsDir = dirname(realpathSync(execSync("command -v playwright-core", { shell: "/bin/sh" }).toString().trim()));
const { chromium } = await import(join(toolsDir, "index.mjs"));
const axeSource = readFileSync(createRequire(join(toolsDir, "index.js")).resolve("axe-core"), "utf8");

const PORT = 3216;
const BASE = `http://localhost:${PORT}`;
const HOME = `${BASE}/account`;
const PAY = `${BASE}/account/pay`;
const SPENDING = `${BASE}/account/spending`;
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
const PAUSE = `${BASE}/account/spend-pause`;
const SHOP = `${BASE}/demo/shop`;

async function open({ mode = "complex", viewport = PHONE, prefs, init } = {}) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([
    { name: "cfe-mode", value: mode, domain: "localhost", path: "/" },
    ...(prefs ? [{ name: "cfe-prefs", value: encodeURIComponent(JSON.stringify(prefs)), domain: "localhost", path: "/" }] : []),
  ]);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("503")) problems.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
  return page;
}

const main = (page) => page.locator("main").innerText();
const has = async (page, text) => (await main(page)).includes(text);
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const setMode = (page, value) => page.context().addCookies([{ name: "cfe-mode", value, domain: "localhost", path: "/" }]);
const home = async (page) => {
  await page.goto(HOME);
  await page.getByRole("link", { name: /Spend Pause is (on|off)/ }).waitFor();
};
const openPay = async (page) => {
  await page.goto(PAY);
  await page.getByRole("button", { name: "Review payment" }).waitFor();
};
const pay = async (page, pounds) => {
  await openPay(page);
  await page.getByRole("radio", { name: "Other amount" }).check();
  await page.getByLabel("Amount in pounds").fill(pounds);
  await page.getByRole("button", { name: "Review payment" }).click();
  await page.getByRole("button", { name: "Confirm payment" }).click();
  await page.getByRole("heading", { name: "Payment recorded" }).waitFor();
};
const payStatement = async (page) => {
  await openPay(page);
  await page.getByRole("radio", { name: /Statement balance/ }).check();
  await page.getByRole("button", { name: "Review payment" }).click();
  await page.getByRole("button", { name: "Confirm payment" }).click();
  await page.getByRole("heading", { name: "Payment recorded" }).waitFor();
};
const pauseStatus = (page) => page.getByRole("heading", { name: /Spend Pause is (on|off)/ }).waitFor();
const turn = async (page, state) => {
  await page.goto(PAUSE);
  await pauseStatus(page);
  await page.getByRole("button", { name: `Turn ${state} Spend Pause` }).click();
  await page.getByRole("button", { name: `Yes, turn it ${state}` }).click();
  await page.getByRole("heading", { name: `Spend Pause is ${state}` }).waitFor();
};
const buyThenGoAhead = async (page) => {
  await page.goto(SHOP);
  await page.getByRole("button", { name: "Buy" }).click();
  await page.waitForURL("**/spend-pause/check");
  await page.getByRole("button", { name: "Go ahead" }).click();
  await page.getByRole("heading", { name: "Purchase made" }).waitFor();
};
const spendingText = async (page) => {
  await page.goto(SPENDING);
  await page.getByText("Payment received").first().waitFor();
  return main(page);
};
async function axe(page, label) {
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.addScriptTag({ content: axeSource });
  const found = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] });
    return result.violations.map((v) => `${v.id}: ${v.nodes[0].html.slice(0, 90)} ${v.nodes[0].failureSummary?.replace(/\s+/g, " ").slice(0, 240)}`);
  });
  check(`axe: ${label}`, found.length === 0, found.join(" ; "));
}

try {
  console.log("\nScenario A: Pay");
  {
    const page = await open();
    await home(page);
    check("Home starts at £1,069.89", await has(page, "£1,069.89"));
    await payStatement(page);
    check("success shows £583.69", await has(page, "£583.69"));
    await home(page);
    check("Home shows £583.69", await has(page, "£583.69"));
    check("Home no longer shows the old balance", !(await has(page, "£1,069.89")));
    const spending = await spendingText(page);
    check("the payment is in the history", spending.includes("+£486.20"));
    check("purchase spending is still £402.35", spending.includes("£402.35"));
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await page.getByRole("link", { name: /Spend Pause is/ }).waitFor();
    check("navigating back keeps it", await has(page, "£583.69"));
    await page.context().close();
  }

  console.log("\nScenario B: Spend Pause");
  {
    const page = await open({ mode: "simple" });
    await home(page);
    check("starts off", await page.getByRole("link", { name: /Spend Pause is off/ }).isVisible());
    await turn(page, "on");
    await page.getByRole("link", { name: "Spending", exact: true }).click();
    await page.waitForURL("**/account/spending");
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await page.getByRole("link", { name: /Spend Pause is on/ }).waitFor();
    check("still on after navigating", true);
    for (const m of ["complex", "simple"]) {
      await setMode(page, m);
      await home(page);
      check(`${m} shows it on`, await page.getByRole("link", { name: /Spend Pause is on: we check before anything over £100\.00/ }).isVisible());
    }
    await turn(page, "off");
    await home(page);
    check("off everywhere after turning it off", await page.getByRole("link", { name: /Spend Pause is off/ }).isVisible());
    await page.context().close();
  }

  console.log("\nScenario C: both together");
  {
    const page = await open();
    await turn(page, "on");
    await pay(page, "100");
    check("pays while Spend Pause is on", await has(page, "£969.89"));
    await home(page);
    check("Spend Pause stays on after paying", await page.getByRole("link", { name: /Spend Pause is on/ }).isVisible());
    check("balance is right", await has(page, "£969.89"));
    check("spending is right", (await spendingText(page)).includes("£402.35"));
    await page.reload();
    await home(page);
    check("both survive a refresh", (await has(page, "£969.89")) && (await page.getByRole("link", { name: /Spend Pause is on/ }).isVisible()));
    await page.context().close();
  }
  {
    const page = await open();
    await pay(page, "100");
    await turn(page, "on");
    await home(page);
    check("turning it on after a payment keeps the balance", await has(page, "£969.89"));
    await page.context().close();
  }

  console.log("\nScenario D: financial integrity");
  {
    const page = await open();
    const before = await (async () => {
      await page.goto(SPENDING);
      await page.getByText("Tesco").first().waitFor();
      return main(page);
    })();
    await payStatement(page);
    await turn(page, "on");
    await turn(page, "off");
    await turn(page, "on");
    const after = await spendingText(page);
    const shopping = (text) => text.split("\n").filter((line) => !/Payment|\+£486\.20|Pending|^\d+ transactions/.test(line)).join("\n");
    const beforeLines = shopping(before).split("\n");
    const afterLines = shopping(after).split("\n");
    const changed = [...beforeLines.filter((l) => !afterLines.includes(l)), ...afterLines.filter((l) => !beforeLines.includes(l))];
    check("every purchase row and total is unchanged by Pay and Spend Pause", changed.length === 0, JSON.stringify(changed.slice(0, 12)));
    await home(page);
    check("the balance is unchanged by Spend Pause", await has(page, "£583.69"));
    await page.context().close();
  }

  console.log("\nPurchases and limits");
  {
    const page = await open();
    await turn(page, "on");
    await payStatement(page);
    await page.goto(SHOP);
    await page.getByRole("button", { name: "Buy" }).click();
    await page.waitForURL("**/spend-pause/check");
    await page.getByRole("alertdialog").waitFor();
    const text = await page.getByRole("alertdialog").innerText();
    check("a payment doesn't lift the spending limit: still £22.35 over", text.includes("£22.35"));
    check("the check uses the balance after the payment", text.includes("£703.69"));
    await page.getByRole("button", { name: "Go ahead" }).click();
    await page.getByRole("heading", { name: "Purchase made" }).waitFor();
    await home(page);
    check("payment then purchase: balance is £703.69", await has(page, "£703.69"));
    check("the purchase isn't on the bill", await has(page, "Your bill is paid"));
    await openPay(page);
    await page.getByRole("radio", { name: /Full current balance/ }).check();
    await page.getByRole("button", { name: "Review payment" }).click();
    await page.getByRole("button", { name: "Confirm payment" }).click();
    await page.getByRole("heading", { name: "Payment recorded" }).waitFor();
    check("the whole balance, purchase included, can be paid", await has(page, "£0.00"));
    await page.reload();
    await page.getByText("You have nothing to pay.").waitFor();
    check("a purchase and its payment are both restored after a refresh", true);
    const spending = await spendingText(page);
    check("spending counts the purchase and not the payment", spending.includes("£522.35"));
    await page.context().close();
  }
  {
    const page = await open();
    await turn(page, "on");
    await turn(page, "off");
    await page.goto(SHOP);
    await page.getByRole("button", { name: "Buy" }).click();
    await page.getByText("Spend Pause didn't need to check this one").waitFor();
    check("with Spend Pause off, a purchase over the limit goes straight through", true);
    await page.context().close();
  }

  console.log("\nScenario E: adaptive UI");
  {
    const prefs = { textSize: 150, contrast: "high", explanations: "stepByStep" };
    const page = await open({ mode: "simple", prefs });
    await pay(page, "100");
    await turn(page, "on");
    const figures = {};
    for (const m of ["simple", "complex"]) {
      await setMode(page, m);
      await openPay(page);
      const payText = await main(page);
      await page.goto(PAUSE);
      await pauseStatus(page);
      const pauseText = await main(page);
      figures[m] = ["£969.89", "£386.20", "£25.00"].every((f) => payText.includes(f)) && pauseText.includes("Spend Pause is on") && pauseText.includes("On since Sunday 8 November at 10:00");
    }
    check("Simple and Detailed show the same facts on both screens", figures.simple && figures.complex, JSON.stringify(figures));
    const root = await page.evaluate(() => ({ ...document.documentElement.dataset }));
    check("text size and contrast survive", root.text === "150" && root.contrast === "high", JSON.stringify(root));
    check("step-by-step survives on Spend Pause", (await page.locator("main ol li").count()) === 4);
    await openPay(page);
    check("step-by-step survives on Pay", (await page.locator("main ol li").count()) === 3);
    await page.context().close();
  }

  console.log("\nWhat Dial's backend receives");
  {
    const page = await open();
    const bodies = [];
    await page.route("**/api/ask", async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answer: "Noted.", evidenceIds: [], source: "template" }) });
    });
    const ask = async (question) => {
      await page.getByRole("button", { name: /Dial/ }).first().click();
      const input = page.getByRole("dialog").getByRole("textbox");
      await input.fill(question);
      await input.press("Enter");
      await page.getByRole("dialog").getByText(/Noted\.|Spend Pause/).first().waitFor();
      const text = await page.getByRole("dialog").innerText();
      await page.keyboard.press("Escape");
      return text;
    };
    await home(page);
    await ask("How much do I owe?");
    check("no payments yet: an empty list", bodies.at(-1).state.payments.length === 0 && bodies.at(-1).state.spendPause.enabled === false);
    await pay(page, "100");
    await pay(page, "50.25");
    await turn(page, "on");
    await buyThenGoAhead(page);
    await home(page);
    await ask("How much do I owe?");
    const sent = bodies.at(-1);
    check("the question is sent as `question`", sent.question === "How much do I owe?");
    check("payments are sent oldest first", sent.state.payments.map((p) => p.amount).join() === "10000,5025", JSON.stringify(sent.state.payments));
    check("each payment is id, date and amount only", sent.state.payments.every((p) => Object.keys(p).sort().join() === "amount,date,id" && /^[a-z0-9-]{1,40}$/i.test(p.id)));
    check("the purchase is sent", sent.state.purchases.length === 1 && sent.state.purchases[0].merchant === "Northwind Audio" && sent.state.purchases[0].amount === 12000);
    check("Spend Pause is sent as on", sent.state.spendPause.enabled === true);
    check("only the contract's fields are sent", Object.keys(sent.state).sort().join() === "payments,purchases,spendPause");
    check("no balance is ever sent", !/[bB]alance|minimumPayment/.test(JSON.stringify(sent.state)));
    check("it fits the 16 KB limit", JSON.stringify(sent).length < 16384);
    await openPay(page);
    await page.getByRole("button", { name: /^Undo £100\.00/ }).click();
    await page.getByText("is back to").waitFor();
    await ask("How much do I owe?");
    check("an undone payment leaves the list at once", bodies.at(-1).state.payments.map((p) => p.amount).join() === "5025");
    await page.context().close();
  }

  console.log("\nDial and Voice Mode from live state, with the backend down");
  {
    const page = await open();
    await page.route("**/api/ask", (route) => route.fulfill({ status: 503, body: "{}" }));
    await turn(page, "on");
    await payStatement(page);
    await home(page);
    await page.getByRole("button", { name: /Dial/ }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Talk to Dial" }).click();
    const voice = page.locator("dialog.voice-mode");
    await voice.waitFor();
    await voice.getByRole("button", { name: /Type/ }).click();
    const say = async (text, expected) => {
      await voice.getByRole("textbox").fill(text);
      await voice.getByRole("textbox").press("Enter");
      await voice.getByText(expected).first().waitFor({ timeout: 5000 });
      return true;
    };
    check("Voice Mode knows Spend Pause is on", await say("Is Spend Pause active?", /since Sunday 8 November at 10:00/));
    check("Voice Mode knows when", await say("When did I activate it?", /You turned on Spend Pause on Sunday 8 November at 10:00/));
    check("Voice Mode knows the balance isn't affected", await say("Is my account balance affected by Spend Pause?", /doesn.t change your balance/));
    check("Voice Mode reads the new balance", await say("read my balance", /Your bill is paid\. You owe £583\.69 in total/));
    await voice.getByRole("textbox").fill("go to pay");
    await voice.getByRole("textbox").press("Enter");
    await page.waitForURL("**/account/pay");
    await page.getByRole("button", { name: "Review payment" }).waitFor();
    check("going to Pay from Voice Mode keeps the balance", await has(page, "£583.69"));
    await page.keyboard.press("Escape");
    await page.goto(PAUSE);
    await pauseStatus(page);
    check("leaving Voice Mode keeps Spend Pause on", await page.getByRole("heading", { name: "Spend Pause is on" }).isVisible());
    await page.context().close();
  }

  console.log("\nInvalid saved state");
  for (const [label, init] of [
    ["a £0 limit", `localStorage.setItem("cfe-spend-pause-settings", '{"enabled":true,"singlePurchaseThreshold":0,"monthlyBudget":null,"quietHours":null}')`],
    ["a damaged activity record", `localStorage.setItem("cfe-spend-pause-activity", "{oops")`],
    ["damaged payments", `sessionStorage.setItem("cfe-payments-session", "[1,2")`],
    ["payments larger than the balance", `sessionStorage.setItem("cfe-payments-session", '[{"id":"pay-1","amount":999999,"date":"2026-11-08","kind":"custom"}]')`],
  ]) {
    const page = await open({ init });
    await home(page);
    check(`${label} falls back safely`, (await has(page, "£1,069.89")) && (await page.getByRole("link", { name: /Spend Pause is off/ }).isVisible()));
    await page.context().close();
  }

  console.log("\nLayouts and contrast, on both screens");
  for (const [label, viewport, prefs] of [
    ["320px", { width: 320, height: 640 }],
    ["390px", PHONE],
    ["768px", { width: 768, height: 1024 }],
    ["desktop", DESKTOP],
    ["200% text at 320px", { width: 320, height: 640 }, { textSize: 200 }],
    ["high contrast", PHONE, { contrast: "high" }],
    ["dark high contrast", PHONE, { theme: "dark", contrast: "high" }],
  ]) {
    for (const mode of ["complex", "simple"]) {
      const page = await open({ mode, viewport, prefs });
      await page.goto(PAUSE);
      await pauseStatus(page);
      if (prefs?.textSize) check(`${label}, ${mode}: the text size really applied`, (await page.evaluate(() => document.documentElement.dataset.text)) === "200");
      const pauseFits = await fits(page);
      await page.getByRole("button", { name: "Turn on Spend Pause" }).click();
      await page.getByRole("button", { name: "Yes, turn it on" }).click();
      await page.getByRole("heading", { name: "Spend Pause is on" }).waitFor();
      const onFits = await fits(page);
      if (prefs) await axe(page, `Spend Pause, ${label}, ${mode}`);
      await pay(page, "100");
      const payFits = await fits(page);
      await home(page);
      const homeFits = await fits(page);
      check(`${label}, ${mode}: no sideways scroll`, pauseFits && onFits && payFits && homeFits, JSON.stringify({ pauseFits, onFits, payFits, homeFits }));
      if (prefs) await axe(page, `Home, ${label}, ${mode}`);
      await page.context().close();
    }
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
