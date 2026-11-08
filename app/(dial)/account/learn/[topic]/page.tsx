import { notFound } from "next/navigation";
import { LearnTopic } from "@/components/learn/learn-screen";
import { isTopic, TOPICS } from "@/lib/learn/topics";

export async function generateMetadata({ params }: { params: Promise<{ topic: string }> }) {
  const { topic } = await params;
  return { title: TOPICS.find((t) => t.slug === topic)?.title ?? "Credit Learning Lab" };
}

export default async function LearnTopicPage({ params }: { params: Promise<{ topic: string }> }) {
  const { topic } = await params;
  if (!isTopic(topic)) notFound();
  return <LearnTopic slug={topic} />;
}
