"use client";

import { CircleCheck, CircleX, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { QUIZ, quizProgress, sanitizeAnswers, shuffledOptions, type QuizAnswers } from "@/lib/learn/quiz";
import { cardClass, Meter } from "../ui/panel";

// Answers stay on this device. Storage can be blocked (private windows), so every read and write is guarded and the
// quiz still works for the visit without it.
const KEY = "cfe-quiz";

export function loadQuizAnswers(): QuizAnswers {
  try {
    return sanitizeAnswers(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return {};
  }
}
function save(a: QuizAnswers) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {}
}

const option = "flex min-h-(--target-min) cursor-pointer items-center gap-3 rounded-(--radius) border-2 border-input bg-card px-3 py-2 has-checked:border-primary has-checked:font-bold";

export function Quiz() {
  const [answers, setAnswers] = useState<QuizAnswers>({});
  const [index, setIndex] = useState(0);
  const [choice, setChoice] = useState<number | null>(null);
  const announce = useAnnounce();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const saved = loadQuizAnswers();
    setAnswers(saved);
    const next = QUIZ.findIndex((q) => !(q.id in saved));
    setIndex(next === -1 ? QUIZ.length : next);
  }, []);

  const progress = quizProgress(answers);
  const done = index >= QUIZ.length;
  const q = QUIZ[Math.min(index, QUIZ.length - 1)];
  const answered = q.id in answers;
  const right = answers[q.id] === q.answer;

  const check = (e: React.FormEvent) => {
    e.preventDefault();
    if (choice === null) return;
    const next = { ...answers, [q.id]: choice };
    setAnswers(next);
    save(next);
    announce(choice === q.answer ? `Correct. ${q.explanation}` : `Not quite. The answer is: ${q.options[q.answer]}. ${q.explanation}`);
  };
  const go = (i: number) => {
    setIndex(i);
    setChoice(null);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const restart = () => {
    setAnswers({});
    save({});
    go(0);
  };

  return (
    <div className="flex flex-col gap-(--space)">
      <div className="flex flex-col gap-1">
        <p className="font-bold">
          {progress.answered} of {progress.total} answered, {progress.correct} correct
        </p>
        <Meter label="Quiz progress" value={progress.answered} max={progress.total} valueText={`${progress.answered} of ${progress.total} answered`} />
      </div>

      {done ? (
        <section aria-labelledby="quiz-done" className={`${cardClass} flex flex-col gap-2`}>
          <h2 id="quiz-done" ref={heading} tabIndex={-1} className="text-lg font-bold focus:outline-none">
            You&apos;ve answered every question
          </h2>
          <p>
            You got {progress.correct} of {progress.total} right.{" "}
            {progress.correct === progress.total ? "Every one. Well done." : "Each answer above has its explanation if you'd like another look."}
          </p>
          <button type="button" onClick={restart} className="inline-flex min-h-(--target-min) items-center gap-2 self-start rounded-full bg-primary px-5 font-bold text-primary-foreground">
            <RotateCcw aria-hidden className="size-[1em]" />
            Start again
          </button>
        </section>
      ) : (
        <form onSubmit={check} className={`${cardClass} flex flex-col gap-3`}>
          <fieldset className="flex flex-col gap-2">
            <legend className="pb-2">
              <span className="block text-sm text-muted-foreground">
                Question {index + 1} of {QUIZ.length}
              </span>
              <span ref={heading} tabIndex={-1} className="block text-lg font-bold focus:outline-none">
                {q.prompt}
              </span>
            </legend>
            {shuffledOptions(q).map((o) => (
              <label key={o.index} className={option}>
                <input
                  type="radio"
                  name={`quiz-${q.id}`}
                  checked={(answered ? answers[q.id] : choice) === o.index}
                  disabled={answered}
                  onChange={() => setChoice(o.index)}
                  className="size-[max(1.4em,24px)] shrink-0 accent-primary"
                />
                <span>{o.text}</span>
                {answered && o.index === q.answer && <span className="ml-auto text-sm font-bold text-success">Right answer</span>}
              </label>
            ))}
          </fieldset>
          {answered ? (
            <div className="flex flex-col gap-2">
              <p className={`flex items-start gap-2 font-bold ${right ? "text-success" : "text-attention"}`}>
                {right ? <CircleCheck aria-hidden className="mt-1 size-[1.1em] shrink-0" /> : <CircleX aria-hidden className="mt-1 size-[1.1em] shrink-0" />}
                {right ? "Correct." : `Not quite. The answer is: ${q.options[q.answer]}.`}
              </p>
              <p>{q.explanation}</p>
              <button type="button" onClick={() => go(index + 1)} className="inline-flex min-h-(--target-min) items-center self-start rounded-full bg-primary px-5 font-bold text-primary-foreground">
                {index + 1 < QUIZ.length ? "Next question" : "See your result"}
              </button>
            </div>
          ) : (
            <button type="submit" disabled={choice === null} className="inline-flex min-h-(--target-min) items-center self-start rounded-full bg-primary px-5 font-bold text-primary-foreground disabled:opacity-50">
              Check my answer
            </button>
          )}
        </form>
      )}
    </div>
  );
}
