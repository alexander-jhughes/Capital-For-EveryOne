// End-to-end tests of POST /api/ask against the production build, with a fake Gemini API.
// No real key and no network. Usage: npm run build, then npm run test:http

import { spawn } from "node:child_process";
import http from "node:http";

const API_PORT = 3213;
const APP_PORT = 3212;
const APP = `http://localhost:${APP_PORT}/api/ask`;
const FAKE_KEY = "fake-key-must-never-be-printed";
const CHARGED = "Was I charged twice for anything?";

type Mode =
  | "ok" | "stall" | "reset" | "invalid-key" | "forbidden" | "quota" | "server-error" | "unavailable" | "html"
  | "not-json" | "bad-json-reply" | "wrong-shape" | "empty" | "no-candidates" | "safety" | "cut-off"
  | "invented-amount" | "advice" | "contradiction" | "wrong-balance" | "invented-evidence";

let mode: Mode = "ok";
let modelCalls = 0;
let failures = 0;

const reply = (text: string | null, finishReason = "STOP") =>
  JSON.stringify({ candidates: [{ finishReason, content: { role: "model", parts: text === null ? [] : [{ text }] } }] });
const answer = (text: string, extra: object = {}) => reply(JSON.stringify({ answer: text, ...extra }));
const apiError = (code: number, status: string) => JSON.stringify({ error: { code, status, message: "failed" } });

const fakeApi = http.createServer((request, response) => {
  let received = "";
  request.on("data", (chunk) => (received += chunk));
  request.on("end", () => {
    modelCalls += 1;
    const send = (status: number, body: string, type = "application/json") => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    };
    const isClassify = received.includes("You sort questions");
    switch (mode) {
      case "stall": return;
      case "reset": request.socket.destroy(); return;
      case "invalid-key": return send(400, apiError(400, "INVALID_ARGUMENT"));
      case "forbidden": return send(403, apiError(403, "PERMISSION_DENIED"));
      case "quota": return send(429, apiError(429, "RESOURCE_EXHAUSTED"));
      case "server-error": return send(500, apiError(500, "INTERNAL"));
      case "unavailable": return send(503, apiError(503, "UNAVAILABLE"));
      case "html": return send(502, "<html>Bad gateway</html>", "text/html");
      case "not-json": return send(200, "this is not json");
      case "bad-json-reply": return send(200, reply("Tesco charged you twice"));
      case "wrong-shape": return send(200, reply(JSON.stringify({ text: "hello" })));
      case "empty": return send(200, reply(null));
      case "no-candidates": return send(200, JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }));
      case "safety": return send(200, reply(null, "SAFETY"));
      case "cut-off": return send(200, reply(null, "MAX_TOKENS"));
      case "invented-amount": return send(200, answer("Tesco charged you £999.99 twice."));
      case "advice": return send(200, answer("Tesco charged you £38.62 twice, so you should complain."));
      case "contradiction": return send(200, answer("No, you were not charged twice."));
      case "wrong-balance": return send(200, answer("Your current balance is £486.20."));
      case "invented-evidence": return send(200, answer("Tesco charged you £38.62 twice.", { evidenceIds: ["t999"] }));
      case "ok": return send(200, isClassify ? reply(JSON.stringify({ category: "spend_this_month" })) : answer("Tesco charged you £38.62 twice."));
    }
  });
});

function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed || !detail ? "" : `\n      ${detail}`}`);
}

async function post(body: unknown) {
  const started = Date.now();
  const response = await fetch(APP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, ms: Date.now() - started, body: await response.json() };
}

async function withApp(env: Record<string, string>, run: () => Promise<void>) {
  const app = spawn("node_modules/.bin/next", ["start", "-p", String(APP_PORT)], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let logs = "";
  app.stdout.on("data", (chunk) => (logs += chunk));
  app.stderr.on("data", (chunk) => (logs += chunk));
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fetch(APP, { method: "POST", body: '{"question":""}' });
        break;
      } catch (error) {
        if (attempt > 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await run();
  } finally {
    if (app.pid) process.kill(-app.pid);
  }
  return logs;
}

const isAskResponse = (body: Record<string, unknown>) =>
  Object.keys(body).sort().join() === "answer,evidenceIds,source" && typeof body.answer === "string" && Array.isArray(body.evidenceIds);

async function noKeyTests() {
  console.log("\nNo API key");
  const tesco = await post({ question: "Did I pay Tesco twice this month?" });
  check("demo question uses its fixed answer", tesco.body.source === "cache" && isAskResponse(tesco.body));
  check("evidence is the two Tesco charges", tesco.body.evidenceIds.join() === "t051,t052");
  const spend = await post({ question: "What did I spend this month?" });
  check("November spending has no October evidence", spend.body.evidenceIds.length === 20);
  check("no question gives the summary", (await post({})).body.answer.includes("£402.35"));
  check("current balance", (await post({ question: "What's my current balance?" })).body.answer.includes("£1,069.89"));
  check("need to pay is the statement balance", (await post({ question: "How much do I need to pay?" })).body.answer.startsWith("Your statement balance is £486.20"));
  const narrow = await post({ question: "How much did I spend at Tesco this month?" });
  check("merchant question gets the fallback", narrow.body.answer === "I can't tell that from your transactions." && narrow.body.evidenceIds.length === 0);
  check("empty question is a friendly 400", (await post({ question: "  " })).status === 400);
  check("long question is a friendly 400", (await post({ question: "a".repeat(301) })).status === 400);
  check("bad JSON is a friendly 400", (await post("nope")).status === 400);
}

async function fakeApiTests() {
  console.log("\nFake Gemini API");
  const template = "You may have been charged twice: Tesco, £38.62, on Thursday 5 November and Friday 6 November.";

  const failuresToTest: Mode[] = [
    "invalid-key", "forbidden", "quota", "server-error", "unavailable", "html", "reset", "not-json", "bad-json-reply",
    "wrong-shape", "empty", "no-candidates", "safety", "cut-off", "invented-amount", "advice", "contradiction",
  ];
  for (const failure of failuresToTest) {
    mode = failure;
    const { status, body } = await post({ question: CHARGED });
    check(`${failure}: template answer, right evidence`, status === 200 && body.source === "template" && body.answer === template && body.evidenceIds.join() === "t051,t052", JSON.stringify(body));
  }

  mode = "invented-evidence";
  const invented = await post({ question: CHARGED });
  check("evidence from the model is ignored", invented.body.evidenceIds.join() === "t051,t052", JSON.stringify(invented.body));

  mode = "stall";
  const stalled = await post({ question: CHARGED });
  check("stall: template inside the 4 second limit", stalled.body.source === "template" && stalled.ms >= 3900 && stalled.ms < 4600, `${stalled.ms}ms`);
  const unknown = await post({ question: "Am I square with you lot?" });
  check("stall while classifying: fallback inside the limit", unknown.body.answer.startsWith("I can't tell") && unknown.ms < 4600, `${unknown.ms}ms`);

  mode = "wrong-balance";
  const balance = await post({ question: "What's my current balance?" });
  check("reply naming the wrong balance is replaced", balance.body.answer === "Your current balance is £1,069.89." && balance.body.source === "template", JSON.stringify(balance.body));

  mode = "ok";
  const good = await post({ question: CHARGED });
  check("valid reply is used", good.body.source === "model" && isAskResponse(good.body), JSON.stringify(good.body));

  modelCalls = 0;
  mode = "server-error";
  for (const question of ["Did I pay Tesco twice this month?", "What did I spend this month?", "Has any subscription gone up?", "When is my bill due?"]) {
    check(`no model call: ${question}`, (await post({ question })).body.source === "cache");
  }
  const narrow = await post({ question: "How much did I spend at Tesco this month?" });
  check("narrow question gets the fallback", narrow.body.answer.startsWith("I can't tell"));
  check("none of those called the model", modelCalls === 0, `${modelCalls} calls`);
}

await new Promise<void>((resolve) => fakeApi.listen(API_PORT, resolve));
await withApp({ GEMINI_API_KEY: "" }, noKeyTests);
const logs = await withApp({ GEMINI_API_KEY: FAKE_KEY, GOOGLE_GEMINI_BASE_URL: `http://localhost:${API_PORT}` }, fakeApiTests);
check("the API key is not in the server logs", !logs.includes(FAKE_KEY));
check("no raw error details in the server logs", !/Error:|at .+:\d+:\d+/.test(logs), logs.slice(0, 300));
fakeApi.closeAllConnections();
fakeApi.close();

console.log(`\n${failures === 0 ? "All passed" : `${failures} failed`}`);
if (failures > 0) process.exitCode = 1;
