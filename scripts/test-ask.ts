// Runs 10 questions against a running server and prints each answer, source and evidence.
// Usage: npm run dev, then in another terminal: npm run test:ask
// Set ASK_URL to test somewhere else. Questions 9 and 10 are ones the data can't answer.

const url = process.env.ASK_URL ?? "http://localhost:3000/api/ask";

const QUESTIONS = [
  "Did I pay Tesco twice this month?",
  "What did I spend this month?",
  "Has any subscription gone up?",
  "When is my bill due?",
  "What did I spend last month?",
  "What were my biggest purchases?",
  "What is my minimum payment?",
  "Is Spend Pause on?",
  "What is my credit score?",
  "Should I get a second credit card?",
];

let failures = 0;

for (const [index, question] of QUESTIONS.entries()) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const body = await response.json();
    if (!response.ok) failures += 1;
    console.log(`${index + 1}. ${question}`);
    console.log(`   Answer:   ${body.answer ?? body.error}`);
    console.log(`   Source:   ${body.source ?? `HTTP ${response.status}`} (${Date.now() - started}ms)`);
    console.log(`   Evidence: ${body.evidenceIds?.join(", ") || "none"}`);
  } catch {
    failures += 1;
    console.log(`${index + 1}. ${question}\n   Could not reach ${url}. Is the server running?`);
  }
}

if (failures > 0) process.exitCode = 1;

export {};
