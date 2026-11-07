// End-to-end tests of POST /api/ask against the production build, with a fake Anthropic API.
// No real key and no network. Usage: npm run build, then npm run test:http

import { spawn } from "node:child_process";
import http from "node:http";

const API_PORT = 3213;
const APP_PORT = 3212;
const APP = `http://localhost:${APP_PORT}/api/ask`;
const FAKE_KEY = "fake-key-must-never-be-printed";
const CHARGED = "Was I charged twice for anything?";

type Mode = "ok" | "stall" | "500" | "429" | "401" | "refusal" | "bad-reply" | "contradiction" | "wrong-balance" | "cut-off" | "not-json" | "html" | "empty" | "no-content" | "reset";

let mode: Mode = "ok";
let modelCalls = 0;
let failures = 0;

const message = (text: string | null, stopReason = "end_turn", extra: object = {}) =>
  JSON.stringify({
    id: "m", type: "message", role: "assistant", model: "m", stop_sequence: null, stop_reason: stopReason,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: text === null ? [] : [{ type: "text", text }],
    ...extra,
  });

const apiError = (type: string) => JSON.stringify({ type: "error", error: { type, message: "failed" } });

const fakeApi = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    modelCalls += 1;
    const send = (status: number, body: string, type = "application/json") => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    };
    switch (mode) {
      case "stall": return;
      case "reset": request.socket.destroy(); return;
      case "500": return send(500, apiError("api_error"));
      case "429": return send(429, apiError("rate_limit_error"));
      case "401": return send(401, apiError("authentication_error"));
      case "refusal": return send(200, message("You owe £1.", "refusal"));
      case "bad-reply": return send(200, message("You owe £999.99 and should pay it now."));
      case "contradiction": return send(200, message("No, you were not charged twice."));
      case "wrong-balance": return send(200, message("Your current balance is £486.20."));
      case "cut-off": return send(200, message(null, "max_tokens"));
      case "not-json": return send(200, "this is not json");
      case "html": return send(502, "<html>Bad gateway</html>", "text/html");
      case "empty": return send(200, message(null));
      case "no-content": return send(200, message(null, "end_turn", { content: undefined }));
      case "ok": return send(200, message("Tesco charged you £38.62 twice."));
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
  console.log("\nFake Anthropic API");
  const template = "You may have been charged twice: Tesco, £38.62, on Thursday 5 November and Friday 6 November.";

  for (const failure of ["500", "429", "401", "refusal", "bad-reply", "contradiction", "cut-off", "not-json", "html", "empty", "no-content", "reset"] as const) {
    mode = failure;
    const { status, body } = await post({ question: CHARGED });
    check(`${failure}: template answer, right evidence`, status === 200 && body.source === "template" && body.answer === template && body.evidenceIds.join() === "t051,t052", JSON.stringify(body));
  }

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
  mode = "500";
  for (const question of ["Did I pay Tesco twice this month?", "What did I spend this month?", "Has any subscription gone up?", "When is my bill due?"]) {
    check(`no model call: ${question}`, (await post({ question })).body.source === "cache");
  }
  const narrow = await post({ question: "How much did I spend at Tesco this month?" });
  check("narrow question gets the fallback", narrow.body.answer.startsWith("I can't tell"));
  check("none of those called the model", modelCalls === 0, `${modelCalls} calls`);
}

await new Promise<void>((resolve) => fakeApi.listen(API_PORT, resolve));
await withApp({ ANTHROPIC_API_KEY: "" }, noKeyTests);
const logs = await withApp({ ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: `http://localhost:${API_PORT}` }, fakeApiTests);
check("the API key is not in the server logs", !logs.includes(FAKE_KEY));
check("no raw error details in the server logs", !/Error:|at .+:\d+:\d+/.test(logs), logs.slice(0, 300));
fakeApi.closeAllConnections();
fakeApi.close();

console.log(`\n${failures === 0 ? "All passed" : `${failures} failed`}`);
if (failures > 0) process.exitCode = 1;
