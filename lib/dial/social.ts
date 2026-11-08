// The human side of Dial: hello, how are you, thanks, sorry, "ugh", a joke, a bad day. Pure and deterministic, on the
// device, so it is instant, works offline and never sends a feeling to a server.
//
// Two rules keep it safe:
// - It never says a figure, a date or anything about the account. Money questions still go to the money code.
// - Words that suggest someone might be in danger always get the same careful, fixed reply with real help,
//   never a joke and never a model's improvisation.
//
// A greeting in front of a real request ("hi, did I pay Tesco twice?") gets a short hello, then the request as normal.

export type SocialKind =
  | "crisis"
  | "hardship"
  | "greeting"
  | "how_are_you"
  | "thanks"
  | "goodbye"
  | "compliment"
  | "frustration"
  | "apology"
  | "laugh"
  | "joke"
  | "feeling_low"
  | "off_topic"
  | "ok";

export interface SocialReply {
  kind: SocialKind;
  text: string;
  link?: { label: string; href: string };
}

/** Lower case, plain words, padded with spaces so patterns can use " word " boundaries. */
const norm = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;

const has = (s: string, re: RegExp) => re.test(s);

// ─── Safety first ─────────────────────────────────────────────────────────────────────────────────────────────────

const CRISIS = / (kill myself|killing myself|end my life|end it all|take my (own )?life|want to die|wanna die|don't want to (live|be here)|dont want to (live|be here)|suicid\w*|self harm|hurt myself|harm myself|no reason to live|can't go on|cant go on|better off dead|better off without me) /;

/** Money trouble, said as trouble (not "how much is my bill?"). */
const HARDSHIP = / (can't afford|cant afford|cannot afford|can't pay|cant pay|cannot pay|unable to pay|struggling (to pay|with money|with my bills|financially|with debt)|behind on (my )?(payments|bills|card)|in debt|drowning in debt|money is tight|broke this month|i'm broke|im broke|can't make (the|my) payment|cant make (the|my) payment|losing my job|lost my job) /;

// ─── Everyday social moments ──────────────────────────────────────────────────────────────────────────────────────

const GREETING = /^ (hi|hiya|hello|hey|heya|yo|howdy|hi there|hello there|hey there|hey dial|hi dial|hello dial|good (morning|afternoon|evening|day)|morning|evening|afternoon|greetings|sup|wassup|whats up|what's up|wagwan|alright|alright mate|you alright|ya alright)\b/;
const HOW_ARE_YOU = / (how are you|how r u|how are u|how're you|hows it going|how's it going|how is it going|how are things|how you doing|how're you doing|how ya doing|you doing ok|you ok|are you ok|how's your day|hows your day|how is your day|what's new|whats new|how have you been) /;
const THANKS = / (thanks|thank you|thank u|thx|ty|cheers|ta|much appreciated|appreciate it|appreciate that|that's helpful|thats helpful|that helped|helpful thanks|brilliant thanks|nice one|lovely thanks) /;
const GOODBYE = /^ (bye|goodbye|bye bye|see you|see ya|cya|later|laters|night|good night|goodnight|take care|catch you later|that's all thanks|thats all thanks)( dial)?( thanks| thank you)? $/;
const COMPLIMENT = / (you're (great|amazing|brilliant|awesome|the best|helpful|smart|clever|lovely)|youre (great|amazing|brilliant|awesome|the best|helpful|smart)|you are (great|amazing|brilliant|awesome|the best|helpful|smart|clever|lovely)|good (job|bot|work)|well done|love (this|you|it)|this is (great|amazing|brilliant|awesome|cool)|nice work|you rock|legend) /;
const FRUSTRATION = / (ugh+|argh+|ffs|for god's sake|for gods sake|useless|rubbish|annoying|you're wrong|youre wrong|that's wrong|thats wrong|not what i (said|meant|asked)|you don't understand|you dont understand|you're not listening|youre not listening|not helpful|this isn't working|this isnt working|stupid|pointless) |^ (huh|eh|what|seriously|come on|omg)\?? $/;
/** Money words: a frustrated sentence about the account ("my balance is wrong") is a money question, not a mood. */
const MONEY = / (bill|balance|spend|spent|spending|refund|payment|payments|owe|transaction|transactions|charged|charge|tesco|amazon|netflix|subscription|budget|statement|credit|limit|minimum) /;
const APOLOGY = /^ (sorry|my bad|oops|whoops|apologies|my mistake|sorry about that|sorry my bad)( dial)? $/;
const LAUGH = /^ (lol|lmao|haha+|hehe+|ha+|rofl|that's funny|thats funny|funny) $/;
const JOKE = / (tell me a joke|tell me something funny|make me laugh|know any jokes|got any jokes|say something funny) /;
const FEELING_LOW = / (i'm|im|i am|feeling|i feel) (sad|down|low|lonely|tired|exhausted|stressed|overwhelmed|having a (bad|rough|hard|tough) day)|(having|had) a (bad|rough|hard|tough|long) day|bad day|rough day|tough day|long day /;
const OFF_TOPIC = / (weather|football|the news|what time is it|what's the time|whats the time|who won|recipe|your favourite|your favorite|do you like|are you married|how old are you|where are you from|meaning of life|sing a song|write me a poem) /;
const OK = /^ (ok|okay|k|cool|nice|great|alright then|fair enough|got it|i see|right|sounds good|perfect|lovely|noted)( thanks| thank you)? $/;

/** Morning, afternoon or evening from a 24-hour clock hour. */
export const partOfDay = (hour: number) => (hour < 5 ? "evening" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening");

/** Picks one of several wordings, turning over with each turn so Dial doesn't repeat itself. */
const pick = (options: string[], turn: number) => options[Math.abs(turn) % options.length];

const HELP_HINT = [
  "What can I help with? Your bill, where your money's going, or how the app looks.",
  "Ask me anything about your card, or tell me if something's hard to see or use.",
  "I can check your bill, your spending, or make the app easier to use. What would you like?",
];

const JOKES = [
  "Why did the credit card go to therapy? It had too many unresolved issues with its balance.",
  "I told my card a joke about interest. It didn't find it very appealing, but it did compound.",
  "My budget and I are on a break. It needed some space, and I needed some money.",
];

export interface SocialContext {
  /** Local hour, 0 to 23, for "good morning" and "good evening". */
  hour: number;
  /** Changes every turn, so wording varies. */
  turn: number;
}

/** A reply for the whole message, when the message is purely social. */
function replyFor(kind: SocialKind, s: string, ctx: SocialContext): SocialReply {
  const t = ctx.turn;
  switch (kind) {
    case "crisis":
      return {
        kind,
        text:
          "I'm really sorry you're feeling like this, and I'm glad you said something. You don't have to deal with it on your own. " +
          "You can talk to Samaritans for free, any time, on 116 123. If you're in danger right now, please call 999. " +
          "Your card and your bill can wait.",
      };
    case "hardship":
      return {
        kind,
        text:
          "That sounds really stressful, and lots of people go through it. Let's look at what's due and the smallest amount you can pay, with no pressure. " +
          "If it feels like too much, free and confidential help is available from StepChange and MoneyHelper, and talking to your card provider early really does help.",
        link: { label: "See what's due", href: "/account/pay" },
      };
    case "greeting": {
      const time = has(s, / good (morning|afternoon|evening) /) || has(s, /^ (morning|afternoon|evening) /) ? `Good ${partOfDay(ctx.hour)}!` : pick(["Hi!", "Hello!", "Hey, nice to hear from you."], t);
      return { kind, text: `${time} ${pick(HELP_HINT, t)}` };
    }
    case "how_are_you":
      return { kind, text: `${pick(["I'm good, thanks for asking!", "Doing well, thank you!", "All good here, thanks!"], t)} ${pick(["How are you getting on?", "How's your day going?", "What can I do for you today?"], t)}` };
    case "thanks":
      return { kind, text: pick(["You're welcome! Anything else?", "Happy to help. Just shout if you need anything else.", "Any time! Is there anything else you'd like to check?"], t) };
    case "goodbye":
      return { kind, text: pick(["Bye for now! I'm here whenever you need me.", "Take care! See you next time.", `Have a lovely ${partOfDay(ctx.hour)}. Bye!`], t) };
    case "compliment":
      return { kind, text: pick(["That's kind of you, thank you! What else can I do?", "Thank you, that made my day. Anything else?", "Aw, thanks! Happy to help any time."], t) };
    case "frustration":
      return {
        kind,
        text: pick(
          [
            "Sorry, that's frustrating. Let's try again: tell me in your own words what you need, and I'll do my best.",
            "I'm sorry I got that wrong. Could you say it another way? You can also tap a suggestion below.",
            "Sorry about that. If talking isn't working, typing always does, or you can say \"help\" to hear what I can do.",
          ],
          t,
        ),
      };
    case "apology":
      return { kind, text: pick(["No problem at all!", "Don't worry about it!", "No need to apologise. What would you like to do?"], t) };
    case "laugh":
      return { kind, text: pick(["Glad that made you smile!", "Ha, I try! What else can I do for you?"], t) };
    case "joke":
      return { kind, text: `${pick(JOKES, t)} Anyway, what can I help with?` };
    case "feeling_low":
      return {
        kind,
        text: pick(
          [
            "Sorry you're having a rough time. I'll keep things simple and quick for you. Is there anything on your card I can take off your mind?",
            "That sounds hard. Take your time. If it helps, I can make the app calmer, or just check one thing for you.",
          ],
          t,
        ),
      };
    case "off_topic":
      return { kind, text: `${pick(["I wish I could help with that, but I only know about your card.", "That's outside what I can do, I'm afraid. I'm just here for your card."], t)} ${pick(HELP_HINT, t)}` };
    case "ok":
      return { kind, text: pick(["Great. Anything else?", "Lovely. I'm here if you need anything.", "Okay! Just ask if you need anything else."], t) };
  }
}

/** Which social moment this is, if the whole message is social. Safety cases are checked first and anywhere. */
export function socialKind(text: string): SocialKind | null {
  const s = norm(text);
  if (s.trim().length === 0) return null;
  if (has(s, CRISIS)) return "crisis";
  if (has(s, HARDSHIP)) return "hardship";
  const words = s.trim().split(" ").length;
  if (has(s, HOW_ARE_YOU) && words <= 8) return "how_are_you";
  if (has(s, GOODBYE)) return "goodbye";
  if (has(s, APOLOGY)) return "apology";
  if (has(s, LAUGH)) return "laugh";
  if (has(s, JOKE)) return "joke";
  if (has(s, FRUSTRATION) && words <= 8 && !has(s, MONEY)) return "frustration";
  if (has(s, COMPLIMENT) && words <= 10) return "compliment";
  if (has(s, THANKS) && words <= 6 && !has(s, MONEY)) return "thanks";
  if (has(s, FEELING_LOW) && words <= 12 && !has(s, MONEY)) return "feeling_low";
  if (has(s, OFF_TOPIC) && words <= 10 && !has(s, MONEY)) return "off_topic";
  if (has(s, OK)) return "ok";
  if (has(s, GREETING) && words <= 4) return "greeting";
  return null;
}

/**
 * A short hello at the front of a real request, and the request without it:
 * "hi Dial, did I pay Tesco twice?" -> { greeting: "Hi!", rest: "did I pay Tesco twice?" }.
 */
export function splitGreeting(text: string, ctx: SocialContext): { greeting: string; rest: string } | null {
  const m = text.match(/^\s*(hi|hiya|hello|hey|heya|good (?:morning|afternoon|evening)|morning|evening|afternoon|thanks|thank you|cheers)(?:\s+(?:there|dial|again))?\s*[,.!:;-]*\s+(.{3,})$/i);
  if (!m) return null;
  const rest = m[2].trim();
  if (socialKind(rest)) return null; // "hi, how are you" is wholly social: handled by socialReply
  const opener = m[1].toLowerCase();
  const greeting = opener.startsWith("thank") || opener === "cheers" ? "Thanks!" : /morning|afternoon|evening/.test(opener) ? `Good ${partOfDay(ctx.hour)}!` : pick(["Hi!", "Hello!", "Hey!"], ctx.turn);
  return { greeting, rest };
}

/** The reply when the whole message is social, or null to carry on with the normal pipeline. */
export function socialReply(text: string, ctx: SocialContext): SocialReply | null {
  // "hi, how are you?" and "hey there how's it going" are one social moment: answer the question part.
  const s = norm(text);
  const kind = socialKind(text) ?? (has(s, GREETING) && has(s, HOW_ARE_YOU) ? "how_are_you" : null);
  return kind ? replyFor(kind, s, ctx) : null;
}

export type SocialTurn =
  /** The whole message was social (or someone needs care): reply, and do nothing else. */
  | { kind: "reply"; reply: SocialReply }
  /** A hello in front of a real request: say it, then handle `rest` as normal. */
  | { kind: "greeting"; greeting: string; rest: string }
  | { kind: "none" };

/** The one entry point Dial's session uses. Safety first, then a greeting in front of a request, then pure social. */
export function socialTurn(text: string, ctx: SocialContext): SocialTurn {
  const kind = socialKind(text);
  if (kind === "crisis" || kind === "hardship") return { kind: "reply", reply: replyFor(kind, norm(text), ctx) };
  const split = splitGreeting(text, ctx);
  if (split) return { kind: "greeting", ...split };
  const reply = socialReply(text, ctx);
  return reply ? { kind: "reply", reply } : { kind: "none" };
}

/**
 * Checks a reply written by the cloud model for small talk. Plain, short, and nothing about money: no digits,
 * currency, dates, links or advice. Anything else is thrown away and Dial uses its own wording.
 */
export function safeChatReply(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 2 || t.length > 240) return null;
  if (/[<>{}\u0000-\u001f\u007f]/.test(t)) return null;
  if (/[0-9£$€%]|https?:|www\.|\.com\b/i.test(t)) return null;
  if (/\b(should|recommend|advise|advice|invest|loan|borrow|interest rate|apr|balance|owe|payment|paid|refund|transaction|pounds?|quid|dollars?)\b/i.test(t)) return null;
  if (/\b(suicide|kill|die|death|self harm)\b/i.test(t)) return null;
  return t;
}
