// POST /api/transcribe: see lib/ai/transcribe.ts. Audio in, text out, through Groq's Whisper. Nothing is stored.
import { handleTranscribe, transcribeStatus } from "@/lib/ai/transcribe";

export const POST = (request: Request) => handleTranscribe(request);
export const GET = () => Response.json(transcribeStatus(), { headers: { "cache-control": "no-store" } });
