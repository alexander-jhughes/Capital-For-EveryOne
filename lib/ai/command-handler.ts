// The POST /api/dial handler (kept out of the route file, which may only export HTTP methods): turns a request the on-device rules couldn't read into validated Dial steps, using Gemini.
// Body: { text: string, screen: { route?: string, mode: "simple" | "complex", textSize: 100 | 125 | 150 | 200 } }
// Reply: { steps: DialStep[], source: "model" | "none" | "failed" }. Money questions still go to /api/ask.
import { interpretCommand, MAX_COMMAND_LENGTH, type CommandModel, type ScreenInfo } from "./command-model";
import { allowModelCall, clientKey } from "./rate-limit";
import { TEXT_SIZES, type TextSize } from "../preferences/schema";

const headers = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 2048;

export function parseBody(raw: unknown): { text: string; screen: ScreenInfo } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { text, screen } = raw as { text?: unknown; screen?: { route?: unknown; mode?: unknown; textSize?: unknown } };
  if (typeof text !== "string" || !text.trim() || text.length > MAX_COMMAND_LENGTH) return null;
  const mode = screen?.mode === "simple" ? "simple" : "complex";
  const size = TEXT_SIZES.find((s) => s === screen?.textSize) as TextSize | undefined;
  const route = typeof screen?.route === "string" && /^\/[a-z/-]{0,40}$/.test(screen.route) ? screen.route : null;
  return { text: text.trim(), screen: { route, mode, textSize: size ?? 100 } };
}

/** The handler apart from choosing the model, so tests can pass a fake one. */
export async function handleDial(request: Request, createModel: () => CommandModel | null): Promise<Response> {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return Response.json({ error: "That was too long." }, { status: 400, headers });
    const body = parseBody(await request.json().catch(() => null));
    if (!body) return Response.json({ error: "Sorry, I couldn't read that." }, { status: 400, headers });
    // Over the limit still replies; it just doesn't spend a Gemini call.
    const model = allowModelCall(clientKey(request)) ? createModel() : null;
    return Response.json(await interpretCommand(body.text, body.screen, model), { headers });
  } catch {
    return Response.json({ error: "Sorry, something went wrong." }, { status: 500, headers });
  }
}

