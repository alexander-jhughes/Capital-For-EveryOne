// Greetings and thanks, answered on the device. "hello" is neither a money question nor a command, so without this it
// fell through to "Sorry, I didn't understand that" even with Gemini working. No network call, no figures.

const normalise = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;

const GREETING = /^ (hello|hi|hey|hiya|howdy|yo|good (morning|afternoon|evening)|hello dial|hi dial|hey dial|dial)( there| dial| again)? $/;
const THANKS = /^ (thanks|thank you|thanks (a lot|so much|dial)|thank you (so much|dial)|cheers|ta|great thanks|perfect thanks|ok thanks|okay thanks) $/;
const HOW_ARE_YOU = /^ (hello |hi |hey )?(how are you|how are you doing|how's it going|how is it going|what's up|whats up|you ok|are you ok|you there|are you there) $/;
const BYE = /^ (bye|goodbye|see you|see you later|good night|night) $/;

const IDEAS = "You could ask where your money goes, when your bill is due, or tell me what to change, like make everything bigger.";

/** A reply for small talk, or null when the text is something else. */
export function smallTalk(text: string): string | null {
  const s = normalise(text);
  if (GREETING.test(s)) return `Hello. I'm Dial, your assistant for this card. ${IDEAS}`;
  if (HOW_ARE_YOU.test(s)) return `I'm ready to help. ${IDEAS}`;
  if (THANKS.test(s)) return "You're welcome. Ask me anything else about your card whenever you like.";
  if (BYE.test(s)) return "Goodbye. I'm here whenever you need me.";
  return null;
}
