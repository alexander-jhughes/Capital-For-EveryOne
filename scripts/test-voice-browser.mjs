// Dial's pause and resume controls and its microphone indicator, end to end in a real browser, at desktop and phone width.
//
// THIS USES A SIMULATED RECOGNISER. window.SpeechRecognition and window.speechSynthesis are fakes this script drives,
// so no real audio and no real speech recognition or speech output is exercised. It proves the panel and the engine
// behave correctly around the browser's events, not that any browser hears anyone.
//
// Usage: npm run build && SESSION_SECRET=<32+ chars> npx next start -p 3140, then
//   BASE_URL=http://localhost:3140 npm run test:voice

import { readFileSync } from "node:fs";
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

const BASE = (process.env.BASE_URL ?? "http://localhost:3140").replace(/\/$/, "");
const HOST = new URL(BASE).hostname;
const DESKTOP = { width: 1366, height: 900 };
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 700 };
const PAUSED = "Paused. The microphone is off.";
const QUESTION = "Make everything bigger";
/** Longer than the engine's longest end-of-utterance pause (2 seconds), so anything that was going to send has sent. */
const SETTLE_MS = 3500;

console.log("SIMULATED recogniser and speech output: no real audio or real speech recognition is exercised.");

let failures = 0;
let passes = 0;
const check = (name, passed, detail = "") => {
  if (passed) passes += 1;
  else failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed || !detail ? "" : `\n      ${detail}`}`);
};

// Playwright's own Chromium if it matches this Playwright, otherwise the installed Chrome.
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "chrome" }));
const problems = [];

/** Runs in the page before any of its scripts. Nothing happens unless the test calls window.__fake. */
function installFakes() {
  const sessions = [];
  class FakeRecognition {
    constructor() {
      this.isOpen = false;
      this.results = [];
      this.aborted = this.stopped = false;
      sessions.push(this);
    }
    start() {
      this.isOpen = true;
    }
    close() {
      this.isOpen = false;
      setTimeout(() => this.onend?.(), 0); // a real recogniser ends a moment later
    }
    stop() {
      this.stopped = true;
      this.close();
    }
    abort() {
      this.aborted = true;
      this.close();
    }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeRecognition;

  const spoken = [];
  const speech = {
    hold: false,
    speak(u) {
      if (!speech.hold) return setTimeout(() => u.onend?.(), 0);
      spoken.push(u);
    },
    cancel() {
      spoken.splice(0).forEach((u) => u.onend?.());
    },
    getVoices: () => [],
  };
  Object.defineProperty(window, "speechSynthesis", { value: speech });

  const current = () => sessions.at(-1);
  const emit = (r) => {
    // The interim result, if any, is always last and gets replaced, as in a real results list.
    if (r.results.at(-1) && !r.results.at(-1).isFinal) r.results.pop();
  };
  const push = (text, isFinal) => {
    const r = current();
    emit(r);
    r.results.push(Object.assign([{ transcript: text }], { isFinal }));
    r.onresult?.({ resultIndex: r.results.length - 1, results: r.results });
  };
  window.__fake = {
    started: () => current()?.onstart?.(),
    interim: (text) => push(text, false),
    final: (text) => push(text, true),
    error(code) {
      const r = current();
      r.isOpen = false;
      r.onerror?.({ error: code });
      r.onend?.();
    },
    stats: () => ({ total: sessions.length, open: sessions.filter((s) => s.isOpen).length, aborted: sessions.filter((s) => s.aborted).length, stopped: sessions.filter((s) => s.stopped).length }),
    holdSpeech: () => (speech.hold = true),
    speaking: () => spoken.length,
    finishSpeech: () => spoken.splice(0).forEach((u) => u.onend?.()),
  };
}

async function open({ viewport = DESKTOP, prefs = {}, hold = null } = {}) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([{ name: "cfe-prefs", value: encodeURIComponent(JSON.stringify({ onboarding: "done", speechInput: "cloud", ...prefs })), domain: HOST, path: "/" }]);
  const page = await context.newPage();
  await page.addInitScript(installFakes);
  // Requests matching `hold` are never answered (and the server never sees them), so whatever waits for them stays waiting.
  if (hold) await page.route(hold, () => {});
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) problems.push(`${page.url()}: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => problems.push(`${page.url()}: ${String(e).slice(0, 200)}`));
  await page.goto(`${BASE}/account`);
  await page.waitForFunction(() => !!window.next?.router);
  await page.locator('nav[aria-label="Main"] button[aria-haspopup="dialog"]').click();
  await panel(page).waitFor();
  // The microphone button only appears once the panel has found the (fake) recogniser.
  await panel(page).getByRole("button", { name: /listening|Hold to talk/ }).waitFor();
  return page;
}

const panel = (page) => page.locator("dialog.voice-mode");
const button = (page, name) => panel(page).getByRole("button", { name, exact: true });
const statusText = (page) => panel(page).getByRole("status").first().innerText();
const input = (page) => panel(page).getByRole("textbox", { name: "Type to Dial" });
const stats = (page) => page.evaluate(() => window.__fake.stats());
const fake = (page, method, arg) => page.evaluate(([m, a]) => window.__fake[m](a), [method, arg]);
const say = async (page, text) => fake(page, "interim", text);
const activeText = (page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");

/** "Make everything bigger" moves the text one size up each time it is sent, so the size counts the questions sent. */
const textSize = (page) => page.locator("html").getAttribute("data-text");
const SENT_ONCE = "125";
const SENT_NEVER = "100";

/** Taps the microphone and has the browser report it started, once the engine has opened its session. */
async function listen(page) {
  await button(page, "Start listening").click();
  await page.waitForFunction(() => window.__fake.stats().open > 0);
  await fake(page, "started");
  await page.waitForFunction(() => !/Allow the microphone/.test(document.querySelector('dialog.voice-mode [role="status"]')?.textContent ?? ""));
}
/** Words in the live transcript only: "Make everything bigger" is also one of Dial's suggestion buttons. */
const spoken = (page, text) => panel(page).locator('p[aria-live="off"]').getByText(text, { exact: true });
/** Listens and hears these words, unfinished, then pauses. */
async function pauseWith(page, words) {
  await listen(page);
  await say(page, words);
  await spoken(page, words).waitFor();
  await button(page, "Pause").click();
  await button(page, "Resume").waitFor();
}
const heard = (page, text) => panel(page).locator("p", { hasText: text }).filter({ hasNotText: "Dial" });

async function scenarios(label, viewport) {
  console.log(`\n${label}: a spoken question, start to finish`);
  {
    const page = await open({ viewport });
    await listen(page);
    check("the status says it is listening, with the backend label", (await statusText(page)).replace(/\s+/g, " ") === "Listening (browser speech service)", await statusText(page));
    await say(page, "Take me");
    await spoken(page, "Take me").waitFor();
    check("interim words appear as they arrive", (await input(page).inputValue()) === "Take me");
    await fake(page, "interim", "Take me to my");
    check("later interim words replace them", (await input(page).inputValue()) === "Take me to my");
    check("the text box is read-only while listening", await input(page).evaluate((e) => e.readOnly));
    await fake(page, "final", "Take me to my spending");
    await page.waitForURL(/\/account\/spending/);
    check("a final result and the pause send one question through the panel", (await heard(page, "Take me to my spending").count()) >= 1 && /spending/i.test(await panel(page).locator("section").innerText()));
    check("the microphone is closed after a tap-mode question", (await stats(page)).open === 0);
    check("Pause has gone once the microphone is off", (await button(page, "Pause").count()) === 0);

    await listen(page);
    check("the sent words don't come back on the next listen", (await input(page).inputValue()) === "", await input(page).inputValue());
    await button(page, "Pause").click();
    await button(page, "Resume").waitFor();
    check("nor as kept words: no Send on an empty pause", (await button(page, "Send what you said").count()) === 0);
    await page.context().close();
  }

  console.log(`\n${label}: the counter this script uses can see a double send`);
  {
    const page = await open({ viewport });
    for (const expected of [SENT_ONCE, "150"]) {
      await input(page).fill(QUESTION);
      await input(page).press("Enter");
      await page.waitForFunction((v) => document.documentElement.dataset.text === v, expected);
    }
    check("two sends reach 150%, one reaches 125%", (await textSize(page)) === "150");
    await page.context().close();
  }

  console.log(`\n${label}: Pause and Resume`);
  {
    const page = await open({ viewport });
    await listen(page);
    await say(page, "Make everything");
    await spoken(page, "Make everything").waitFor();
    await button(page, "Pause").focus();
    await page.keyboard.press("Enter");
    await button(page, "Resume").waitFor();
    check("the status says paused", (await statusText(page)) === PAUSED, await statusText(page));
    check("no pulsing dot while paused", (await panel(page).locator('[role="status"] .animate-pulse').count()) === 0);
    check("focus moves from Pause to Resume", (await activeText(page)) === "Resume", await activeText(page));
    check("the words stay visible", await spoken(page, "Make everything").isVisible());
    check("the text box still shows them, read-only", (await input(page).inputValue()) === "Make everything" && (await input(page).evaluate((e) => e.readOnly)));
    let s = await stats(page);
    check("the recogniser session was aborted and none is open", s.aborted === 1 && s.open === 0, JSON.stringify(s));
    await page.waitForTimeout(SETTLE_MS);
    s = await stats(page);
    check("nothing is sent or reopened after waiting", (await textSize(page)) === SENT_NEVER && s.total === 1 && s.open === 0 && (await statusText(page)) === PAUSED, JSON.stringify(s));
    await input(page).press("Enter");
    check("Enter in the text box can't send while paused", (await textSize(page)) === SENT_NEVER);

    await page.keyboard.press("Tab"); // leave the text box, then come back to the control by keyboard
    await button(page, "Resume").focus();
    await page.keyboard.press("Enter");
    await button(page, "Pause").waitFor();
    check("focus moves from Resume to Pause", (await activeText(page)) === "Pause", await activeText(page));
    s = await stats(page);
    check("Resume opens one new session", s.total === 2 && s.open === 1, JSON.stringify(s));
    check("the kept words are still showing", await spoken(page, "Make everything").isVisible());
    await fake(page, "started");
    await fake(page, "final", "bigger");
    await page.waitForFunction((v) => document.documentElement.dataset.text === v, SENT_ONCE);
    await page.waitForTimeout(SETTLE_MS);
    check("the new words join the same question, sent exactly once", (await textSize(page)) === SENT_ONCE && (await heard(page, QUESTION).count()) >= 1);
    check("no session stays open afterwards", (await stats(page)).open === 0);
    await page.context().close();
  }

  console.log(`\n${label}: the microphone button while paused`);
  {
    const page = await open({ viewport });
    await pauseWith(page, QUESTION); // the whole command, so stopping after the resume has something to deliver
    const mic = button(page, "Resume listening");
    check("it says Resume listening and isn't pressed", (await mic.count()) === 1 && (await mic.getAttribute("aria-pressed")) === "false");
    await mic.click();
    await button(page, "Stop listening").waitFor();
    const s = await stats(page);
    check("it resumes with one session, not a second one", s.total === 2 && s.open === 1, JSON.stringify(s));
    await button(page, "Stop listening").click();
    await page.waitForFunction((v) => document.documentElement.dataset.text === v, SENT_ONCE);
    check("while listening it still stops and sends", (await stats(page)).open === 0);
    await page.context().close();
  }

  console.log(`\n${label}: Send, Cancel and Edit while paused`);
  {
    const page = await open({ viewport });
    await pauseWith(page, QUESTION);
    await button(page, "Send what you said").click();
    await page.waitForFunction((v) => document.documentElement.dataset.text === v, SENT_ONCE);
    await page.waitForTimeout(SETTLE_MS);
    const s = await stats(page);
    check("Send delivers the kept words once", (await textSize(page)) === SENT_ONCE && s.total === 1 && s.open === 0, JSON.stringify(s));
    check("focus goes to the microphone button, not lost", (await activeText(page)) === "Start listening", await activeText(page));
    await page.context().close();
  }
  {
    const page = await open({ viewport });
    await pauseWith(page, QUESTION);
    await button(page, "Cancel").click();
    await button(page, "Start listening").waitFor();
    await page.waitForTimeout(SETTLE_MS);
    check("Cancel sends nothing", (await textSize(page)) === SENT_NEVER);
    check("Cancel clears the words", (await spoken(page, QUESTION).count()) === 0 && (await input(page).inputValue()) === "");
    check("focus goes to the microphone button, not lost", (await activeText(page)) === "Start listening", await activeText(page));
    await page.context().close();
  }
  {
    const page = await open({ viewport });
    await pauseWith(page, QUESTION);
    await button(page, "Edit").click();
    await button(page, "Start listening").waitFor();
    check("Edit puts the words in an editable text box and focuses it", (await input(page).inputValue()) === QUESTION && !(await input(page).evaluate((e) => e.readOnly)) && (await page.evaluate(() => document.activeElement?.tagName)) === "INPUT");
    check("Edit opened no session", (await stats(page)).open === 0);
    await input(page).press("Enter");
    await page.waitForFunction((v) => document.documentElement.dataset.text === v, SENT_ONCE);
    check("Enter sends the edited words through the same pipeline", (await textSize(page)) === SENT_ONCE && (await heard(page, QUESTION).count()) >= 1);
    await page.context().close();
  }

  console.log(`\n${label}: an empty pause, and an old typed value`);
  {
    const page = await open({ viewport });
    await input(page).fill(QUESTION);
    await listen(page);
    await button(page, "Pause").click();
    await button(page, "Resume").waitFor();
    check("no 'Go ahead' prompt", (await panel(page).getByText("Go ahead", { exact: false }).count()) === 0);
    check("no Send for words that aren't there", (await button(page, "Send what you said").count()) === 0);
    check("the form's Send can't send the old typed value", await button(page, "Send").isDisabled());
    await input(page).press("Enter");
    await page.waitForTimeout(300);
    check("nor can Enter", (await textSize(page)) === SENT_NEVER);
    await page.context().close();
  }

  console.log(`\n${label}: while the browser's permission prompt is up`);
  {
    const page = await open({ viewport });
    await button(page, "Start listening").click();
    await panel(page).getByText("Allow the microphone in your browser").waitFor();
    check("no Pause and no 'on' dot until the microphone really opens", (await button(page, "Pause").count()) === 0 && (await panel(page).locator('[role="status"] .animate-pulse').count()) === 0);
    await page.context().close();
  }

  console.log(`\n${label}: focus when the engine ends listening by itself`);
  {
    const page = await open({ viewport });
    await listen(page);
    await say(page, QUESTION);
    await button(page, "Pause").focus();
    await page.waitForFunction((v) => document.documentElement.dataset.text === v, SENT_ONCE);
    await button(page, "Pause").waitFor({ state: "detached" });
    await page.waitForTimeout(100);
    check("the focused Pause went, and focus went to the microphone button", (await activeText(page)) === "Start listening", await activeText(page));
    await page.context().close();
  }

  console.log(`\n${label}: hold to talk`);
  {
    const page = await open({ viewport, prefs: { listenMode: "hold" } });
    const mic = button(page, "Hold to talk");
    await mic.hover();
    await page.mouse.down();
    await fake(page, "started");
    await panel(page).getByText("Listening", { exact: false }).first().waitFor();
    check("no Pause button in push-to-talk", (await button(page, "Pause").count()) === 0);
    await say(page, QUESTION);
    await page.waitForTimeout(SETTLE_MS);
    check("silence doesn't end it", (await textSize(page)) === SENT_NEVER);
    await page.mouse.up();
    await page.waitForFunction((v) => document.documentElement.dataset.text === v, SENT_ONCE);
    check("releasing sends it", (await stats(page)).open === 0);
    await page.context().close();
  }

  console.log(`\n${label}: continuous mode, the microphone stays on while Dial works and speaks`);
  {
    const page = await open({ viewport, prefs: { listenMode: "continuous" } });
    // This question goes to /api/ask, held here so "working" lasts as long as the check needs. The server isn't asked.
    let release;
    const held = new Promise((r) => (release = r));
    await page.route("**/api/ask", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held;
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    await fake(page, "holdSpeech");
    await listen(page);
    await fake(page, "final", "How much did I spend at Tesco?"); // the on-device rules send this one to /api/ask
    await panel(page).getByText("Thinking. Microphone on", { exact: false }).waitFor();
    check("while Dial works, the status says Thinking and Microphone on", /^Thinking\. Microphone on \(browser speech service\)$/.test((await statusText(page)).replace(/\s+/g, " ")), await statusText(page));
    check("the dot is on while Dial works", (await panel(page).locator('[role="status"] .animate-pulse').count()) === 1);
    check("Pause is offered while Dial works", (await button(page, "Pause").count()) === 1);
    check("the microphone button says Stop, truthfully", (await button(page, "Stop listening").count()) === 1);
    check("one session stayed open", (await stats(page)).open === 1);
    release();
    await panel(page).getByText("Speaking. Microphone on", { exact: false }).waitFor();
    check("while Dial speaks, the status says Speaking and Microphone on", /^Speaking\. Microphone on/.test(await statusText(page)), await statusText(page));
    check("the dot is on while Dial speaks", (await panel(page).locator('[role="status"] .animate-pulse').count()) === 1);
    await button(page, "Pause").click();
    await button(page, "Resume").waitFor();
    check("Pause while Dial speaks closes the microphone and says so", (await statusText(page)) === PAUSED && (await stats(page)).open === 0, await statusText(page));
    await button(page, "Resume").click();
    await button(page, "Pause").waitFor();
    check("Resume reopens one session", (await stats(page)).open === 1);
    await fake(page, "finishSpeech");
    await panel(page).getByText("Listening", { exact: false }).first().waitFor();
    check("back to Listening once Dial has finished, microphone still on", (await stats(page)).open === 1 && (await panel(page).locator('[role="status"] .animate-pulse').count()) === 1);
    check("the question just answered doesn't reappear as live words", (await input(page).inputValue()) === "", await input(page).inputValue());
    await button(page, "Stop listening").click();
    await button(page, "Start listening").waitFor();
    check("Stop turns the indicator off", (await panel(page).locator('[role="status"] .animate-pulse').count()) === 0 && (await stats(page)).open === 0);
    await page.context().close();
  }

  console.log(`\n${label}: a correction spoken while the first request is still in flight`);
  {
    // The on-device understanding model is held, so the first request waits for it (up to 4 seconds), as on a slow
    // first load. "Actually, not bigger, smaller" then has both words of a contradiction: it must correct the request
    // in flight, not get "Do you want it bigger or smaller?" back (lib/dial/turn-start.ts).
    const page = await open({ viewport, prefs: { listenMode: "continuous", textSize: 125 }, hold: "**/vendor/transformers.min.js" });
    await listen(page);
    await fake(page, "final", "Make the text bigger");
    await panel(page).getByText("Thinking", { exact: false }).first().waitFor();
    check("the first request is still in flight, nothing changed yet", (await textSize(page)) === "125", await textSize(page));
    await fake(page, "final", "Actually, not bigger, smaller");
    await page.waitForFunction(() => document.documentElement.dataset.text === "100", null, { timeout: 15000 }).catch(() => {});
    check("the correction applies to the request in flight: the text goes down a size", (await textSize(page)) === "100", await textSize(page));
    check("Dial doesn't ask whether bigger or smaller", (await panel(page).getByText("Do you want it bigger or smaller?").count()) === 0);
    await page.waitForTimeout(SETTLE_MS + 1000);
    check("the replaced request never applies afterwards", (await textSize(page)) === "100", await textSize(page));
    await button(page, "Stop listening").click();
    await page.context().close();
  }

  console.log(`\n${label}: permission denied`);
  {
    const page = await open({ viewport });
    await button(page, "Start listening").click();
    await fake(page, "error", "not-allowed");
    await panel(page).getByRole("alert").waitFor();
    check("the message says it is blocked", (await panel(page).getByRole("alert").innerText()).includes("Microphone access is blocked"));
    check("no Pause button and no 'on' dot", (await button(page, "Pause").count()) === 0 && (await panel(page).locator('[role="status"] .animate-pulse').count()) === 0);
    await input(page).fill(QUESTION);
    await input(page).press("Enter");
    await page.waitForFunction((v) => document.documentElement.dataset.text === v, SENT_ONCE);
    check("typing still works", true);
    await page.context().close();
  }

  console.log(`\n${label}: closing the panel while paused`);
  {
    const page = await open({ viewport });
    await pauseWith(page, QUESTION);
    await button(page, "Close Dial").click();
    await panel(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(SETTLE_MS);
    const s = await stats(page);
    check("no session opens and nothing is sent", s.open === 0 && s.total === 1 && (await textSize(page)) === SENT_NEVER, JSON.stringify(s));
    await page.locator('nav[aria-label="Main"] button[aria-haspopup="dialog"]').click();
    await panel(page).waitFor();
    check("reopening shows no kept words and no paused state", (await input(page).inputValue()) === "" && (await button(page, "Resume").count()) === 0 && (await button(page, "Start listening").count()) === 1);
    await page.context().close();
  }
}

await scenarios("Desktop", DESKTOP);
await scenarios("Phone", PHONE);

console.log("\nPhone width, 200% text and large targets, while paused");
{
  const page = await open({ viewport: NARROW, prefs: { textSize: 200, targets: "large" } });
  await pauseWith(page, "Make everything bigger and then tell me what I spent on groceries last month");
  const layout = await panel(page).evaluate((d) => {
    const target = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--target-boost")) + parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--base-target"));
    const controls = [...d.querySelectorAll("button")].filter((b) => ["Resume", "Send", "Edit", "Cancel"].includes(b.textContent.trim()));
    return {
      target,
      labels: controls.map((b) => b.textContent.trim()),
      short: controls.filter((b) => b.getBoundingClientRect().height < target).map((b) => b.textContent.trim()),
      wide: [...d.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5 && e.getBoundingClientRect().width > 0).map((e) => e.tagName).slice(0, 5),
      panelFits: d.scrollWidth <= d.clientWidth,
    };
  });
  check("no sideways scrolling on the page", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  check("nothing in the panel runs past the screen edge", layout.panelFits && layout.wide.length === 0, JSON.stringify(layout));
  check("all four controls are there, with visible text", layout.labels.join() === "Resume,Send,Edit,Cancel", layout.labels.join());
  check("each control is at least the large target height", layout.short.length === 0 && layout.target > 44, JSON.stringify(layout));
  const composer = await input(page).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: window.innerHeight };
  });
  check("the text box is still on screen", composer.top >= 0 && composer.bottom <= composer.height, JSON.stringify(composer));
  const reachable = [];
  for (const name of ["Resume", "Send what you said", "Edit", "Cancel"]) {
    await button(page, name).focus();
    const inView = await button(page, name).evaluate((b) => {
      const r = b.getBoundingClientRect();
      const box = b.closest("dialog").getBoundingClientRect();
      return r.top >= box.top && r.bottom <= box.bottom;
    });
    if (inView) reachable.push(name);
  }
  check("each control scrolls into the panel's view when focused", reachable.length === 4, reachable.join());

  if (!axeSource) console.log("SKIP  axe: paused panel (axe-core not found)");
  else {
    await page.waitForTimeout(400);
    await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
    await page.addScriptTag({ content: axeSource });
    const found = await page.evaluate(async () => {
      document.querySelectorAll("dialog.voice-mode details").forEach((d) => (d.open = true));
      const result = await window.axe.run(document.querySelector("dialog.voice-mode"), { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] });
      return result.violations.map((v) => `${v.id}: ${v.nodes[0].html.slice(0, 100)} ${v.nodes[0].failureSummary?.replace(/\s+/g, " ").slice(0, 200)}`);
    });
    check("axe: the panel while paused, 320px, 200% text, large targets", found.length === 0, found.join(" ; "));
  }
  await page.context().close();
}
if (axeSource) {
  const page = await open({ viewport: DESKTOP });
  await pauseWith(page, QUESTION);
  await page.waitForTimeout(400);
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
  await page.addScriptTag({ content: axeSource });
  const found = await page.evaluate(async () => {
    const result = await window.axe.run(document.querySelector("dialog.voice-mode"), { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] });
    return result.violations.map((v) => `${v.id}: ${v.nodes[0].html.slice(0, 100)} ${v.nodes[0].failureSummary?.replace(/\s+/g, " ").slice(0, 200)}`);
  });
  check("axe: the panel while paused, desktop", found.length === 0, found.join(" ; "));
  await page.context().close();
}

check("no console errors or page errors", problems.length === 0, [...new Set(problems)].slice(0, 8).join("\n      "));
await browser.close();
console.log(`\n${passes} passed, ${failures} failed. Recogniser and speech output were SIMULATED: no real audio or real speech recognition was exercised.`);
process.exit(failures ? 1 : 0);
