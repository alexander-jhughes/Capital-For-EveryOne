"use client";

import { ArrowLeft, ArrowRight, Calculator, ChevronRight, FileText, Gauge, ListChecks, Scale } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { quizProgress } from "@/lib/learn/quiz";
import { TOPICS, type TopicSlug } from "@/lib/learn/topics";
import { InterestCalculator, MinimumPaymentExplainer, StatementExplainer, UtilisationSimulator } from "./modules";
import { loadQuizAnswers, Quiz } from "./quiz";

const PARTS: Record<TopicSlug, { Icon: typeof Gauge; Body: () => React.ReactNode }> = {
  utilisation: { Icon: Gauge, Body: UtilisationSimulator },
  "minimum-payments": { Icon: Scale, Body: MinimumPaymentExplainer },
  interest: { Icon: Calculator, Body: InterestCalculator },
  statement: { Icon: FileText, Body: StatementExplainer },
  quiz: { Icon: ListChecks, Body: Quiz },
};

export function LearnHub() {
  const [quiz, setQuiz] = useState<{ answered: number; total: number } | null>(null);
  useEffect(() => setQuiz(quizProgress(loadQuizAnswers())), []);
  return (
    <div className="flex flex-col gap-(--space)">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-bold tracking-tight">Credit Learning Lab</h1>
        <p className="text-lg text-muted-foreground">Short, hands-on ways to understand how your card works. They start from your own figures, and you can change any of them.</p>
        <p className="text-sm text-muted-foreground">Calculations are worked out on this device by fixed rules, not by Dial or any AI, and they&apos;re illustrative: your lender&apos;s figures can differ.</p>
      </div>
      <ul className="grid grid-cols-1 gap-(--space) @xl:grid-cols-2">
        {TOPICS.map(({ slug, title, blurb }) => {
          const { Icon } = PARTS[slug];
          return (
          <li key={slug}>
            <Link href={`/account/learn/${slug}`} className="elevated flex h-full min-h-(--target-min) items-start gap-3 rounded-xl bg-card p-(--space)">
              <Icon aria-hidden className="mt-0.5 size-[1.5em] shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-bold">{title}</span>
                <span className="block text-muted-foreground">{blurb}</span>
                {slug === "quiz" && quiz && quiz.answered > 0 && (
                  <span className="mt-1 block text-sm font-bold">
                    {quiz.answered} of {quiz.total} answered
                  </span>
                )}
              </span>
              <ChevronRight aria-hidden className="mt-1 size-[1.2em] shrink-0" />
            </Link>
          </li>
          );
        })}
      </ul>
    </div>
  );
}

export function LearnTopic({ slug }: { slug: TopicSlug }) {
  const i = TOPICS.findIndex((t) => t.slug === slug);
  const { title } = TOPICS[i];
  const { Body } = PARTS[slug];
  const next = TOPICS[i + 1];
  return (
    <div className="flex flex-col gap-(--space)">
      <nav aria-label="Learning Lab">
        <Link href="/account/learn" className="inline-flex min-h-(--target-min) items-center gap-1.5 font-bold text-primary underline-offset-4 hover:underline">
          <ArrowLeft aria-hidden className="size-[1em]" />
          All topics
        </Link>
      </nav>
      <h1 className="text-xl font-bold tracking-tight">{title}</h1>
      <Body />
      {next && (
        <Link href={`/account/learn/${next.slug}`} className="hairline flex min-h-(--target-min) items-center justify-between gap-3 rounded-xl bg-card px-(--space) py-2 font-bold">
          <span>
            <span className="block text-sm font-normal text-muted-foreground">Next topic</span>
            {next.title}
          </span>
          <ArrowRight aria-hidden className="size-[1.2em] shrink-0 text-primary" />
        </Link>
      )}
    </div>
  );
}
