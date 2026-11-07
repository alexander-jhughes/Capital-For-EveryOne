// Runs 10 questions against a running server and prints each answer, source and evidence.
// Usage: npm run dev, then in another terminal: npm run test:ask
// Set ASK_URL to test somewhere else. Question 9 is too vague to answer, and 10 is one the data can't answer. With GEMINI_API_KEY set, this makes real API calls.

const url = process.env.ASK_URL ?? "http://localhost:3000/api/ask";

const QUESTIONS = [
  "How much do I owe?",
  "How much have I spent this month?",
  "What subscriptions am I paying for?",
  "Have I been charged twice by Tesco?",
  "Where is my Amazon refund?",
  "When is my next payment due?",
  "How much did I spend at Argos?",
  "What subscriptions increased?",
  "How much is it?",
  "What is my credit score?",
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
    console.log(`   Screen:   ${body.experience?.template} (${body.experience?.intent}, ${body.experience?.confidence} confidence)`);
  } catch {
    failures += 1;
    console.log(`${index + 1}. ${question}\n   Could not reach ${url}. Is the server running?`);
  }
}

if (failures > 0) process.exitCode = 1;

export {};
