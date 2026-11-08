// Held-out evaluation set for lib/access. None of these sentences appear in the catalogue's examples: they test whether
// the model understands meaning it was never shown. Each has the situations a careful person would hear in it
// (empty when it is not about the person's situation at all) and, where the sentence says when, the scope.
// Run with: npm run access:eval   (writes docs/ACCESS-EVALUATION.md)
import type { Scope, SituationId } from "./catalogue";

export interface EvalCase {
  text: string;
  expect: SituationId[];
  scope?: Scope;
  /** What kind of sentence this is, for the report's breakdown. */
  group: "situation" | "mixed" | "typo" | "money" | "command" | "negated" | "chat";
}

const s = (text: string, expect: SituationId[], scope?: Scope, group: EvalCase["group"] = "situation"): EvalCase => ({ text, expect, scope, group });
const none = (text: string, group: EvalCase["group"]): EvalCase => ({ text, expect: [], group });

/** Development set: used while building (thresholds were NOT tuned on it; see THRESHOLDS). */
export const EVAL_SET: EvalCase[] = [
  // Night vision
  s("I have trouble seeing at night", ["night_vision"], "night"),
  s("my eyes aren't great once the sun goes down", ["night_vision"]),
  s("when it gets dark I can't read my phone", ["night_vision"], "night"),
  s("the screen glares at me when I'm in bed", ["night_vision"], "night"),
  s("evenings are tough on my eyes", ["night_vision"], "night"),
  s("I find it hard to see the app at bedtime", ["night_vision"], "night"),
  s("it's really hard to read things late in the day", ["night_vision"]),
  s("after dark everything on the screen is a blur", ["night_vision"], "night"),
  s("my phone is way too bright when the lights are off", ["night_vision"]),
  s("night time reading strains my eyes", ["night_vision"]),
  // Low vision
  s("my eyesight has really deteriorated", ["low_vision"]),
  s("I'm losing my sight", ["low_vision"]),
  s("I can't see small writing any more", ["low_vision"]),
  s("I've got cataracts in both eyes", ["low_vision"]),
  s("I need everything much bigger, my eyes are bad", ["low_vision"]),
  s("I'm sight impaired", ["low_vision"]),
  s("I can barely make out the text", ["low_vision"]),
  s("the print is too tiny for my eyes", ["low_vision"]),
  s("my vision is blurry", ["low_vision"]),
  s("I have very poor eyesight", ["low_vision"]),
  // Screen reader
  s("I have no vision at all", ["screen_reader"]),
  s("I'm a blind user", ["screen_reader"]),
  s("I listen to my phone with voiceover", ["screen_reader"]),
  s("I need the app to talk to me because I can't see it", ["screen_reader"]),
  s("I navigate using a screenreader", ["screen_reader"]),
  s("can everything be spoken out loud, I'm blind", ["screen_reader"]),
  // Colour vision
  s("I have red green colour blindness", ["colour_vision"]),
  s("I can't distinguish colours well", ["colour_vision"]),
  s("the red and the green look identical to me", ["colour_vision"]),
  s("I'm colourblind so the warnings don't stand out", ["colour_vision"]),
  s("I don't see red properly", ["colour_vision"]),
  s("my colour vision is poor", ["colour_vision"]),
  // Reading
  s("I've got dyslexia", ["reading"]),
  s("reading is a real struggle for me", ["reading"]),
  s("the letters get jumbled up when I read", ["reading"]),
  s("long text is really hard for me to get through", ["reading"]),
  s("I read very slowly", ["reading"]),
  s("I have a learning difficulty with reading", ["reading"]),
  s("the words blur together into a mess", ["reading"]),
  // Dexterity
  s("my hands tremble", ["dexterity"]),
  s("I've got rheumatoid arthritis", ["dexterity"]),
  s("I always hit the wrong button", ["dexterity"]),
  s("I have trouble using my fingers", ["dexterity"]),
  s("my hands are shaky so I mis-tap a lot", ["dexterity"]),
  s("I have MS and my hands don't work well", ["dexterity"]),
  s("tapping accurately is really difficult for me", ["dexterity"]),
  s("I keep double tapping by mistake", ["dexterity"]),
  // One handed
  s("I've only got one hand free right now", ["one_handed"], "now"),
  s("I'm feeding the baby so I'm using one hand", ["one_handed"]),
  s("I broke my wrist", ["one_handed"]),
  s("I can't reach the top of my phone with my thumb", ["one_handed"]),
  s("I'm standing on the train holding on", ["one_handed"], "now"),
  // Bright light
  s("I'm in the garden and the sun is too bright to see", ["bright_light"]),
  s("there's sunlight on my screen", ["bright_light"]),
  s("it's so sunny I can't read anything", ["bright_light"]),
  s("I'm outside and the screen is unreadable", ["bright_light"], "now"),
  s("the glare is awful", ["bright_light"]),
  // Light sensitivity
  s("I suffer from migraines", ["light_sensitivity"]),
  s("bright light gives me a headache", ["light_sensitivity"]),
  s("the moving bits make me nauseous", ["light_sensitivity"]),
  s("I'm photosensitive", ["light_sensitivity"]),
  s("animations make me feel dizzy", ["light_sensitivity"]),
  s("I have epilepsy so flashing is a problem", ["light_sensitivity"]),
  // Focus
  s("I've got ADHD", ["focus"]),
  s("I find it hard to concentrate", ["focus"]),
  s("this screen is way too busy", ["focus"]),
  s("there's so much stuff I don't know where to look", ["focus"]),
  s("I get overwhelmed with too much information", ["focus"]),
  s("I'm neurodivergent and busy layouts are hard", ["focus"]),
  // Memory
  s("my memory is terrible", ["memory"]),
  s("I've been diagnosed with dementia", ["memory"]),
  s("I keep forgetting things", ["memory"]),
  s("I get confused with lots of steps", ["memory"]),
  s("since my stroke I forget stuff", ["memory"]),
  s("I can't keep things in my head", ["memory"]),
  // Money anxiety
  s("checking my balance gives me anxiety", ["money_anxiety"]),
  s("I panic when I see how much I owe", ["money_anxiety"]),
  s("money stuff makes me really stressed", ["money_anxiety"]),
  s("I'm scared to look at my account", ["money_anxiety"]),
  s("financial things make me nervous", ["money_anxiety"]),
  // Hearing
  s("I am deaf", ["hearing"]),
  s("I can't hear what you say", ["hearing"]),
  s("I'm partially deaf", ["hearing"]),
  s("I have a hearing impairment", ["hearing"]),
  s("I use hearing aids", ["hearing"]),
  s("the speech is useless to me, I can't hear", ["hearing"]),
  // Slow speech
  s("you speak way too fast", ["slow_speech"]),
  s("please talk more slowly", ["slow_speech"]),
  s("could you slow your voice down", ["slow_speech"]),
  s("I can't follow when you talk so quickly", ["slow_speech"]),
  // Second language
  s("english is not my native language", ["second_language"]),
  s("I'm learning English", ["second_language"]),
  s("I don't speak English very well", ["second_language"]),
  s("my English is basic", ["second_language"]),
  s("I'm not fluent in English", ["second_language"]),

  // More than one thing at once
  s("I have arthritis and I struggle to see at night", ["dexterity", "night_vision"], "night", "mixed"),
  s("I'm dyslexic and numbers make me anxious", ["reading", "money_anxiety"], undefined, "mixed"),
  s("I'm colour blind, and I also get distracted easily", ["colour_vision", "focus"], undefined, "mixed"),
  s("my hands shake and you talk too fast", ["dexterity", "slow_speech"], undefined, "mixed"),
  s("I'm deaf and I have ADHD", ["hearing", "focus"], undefined, "mixed"),
  s("I get migraines but I also have poor eyesight", ["light_sensitivity", "low_vision"], undefined, "mixed"),

  // Typos and casual speech (speech recognition and fast typing)
  s("i cant see good at nite", ["night_vision"], "night", "typo"),
  s("im colorblind", ["colour_vision"], undefined, "typo"),
  s("i hav dyslexia", ["reading"], undefined, "typo"),
  s("my hands r shaky", ["dexterity"], undefined, "typo"),
  s("eyes r bad", ["low_vision"], undefined, "typo"),
  s("u talk 2 fast", ["slow_speech"], undefined, "typo"),
  s("im deff", ["hearing"], undefined, "typo"),
  s("got adhd lol", ["focus"], undefined, "typo"),

  // Money questions that sound similar: must NOT change the look of the app
  none("I can't see my refund anywhere", "money"),
  none("I can't find the Netflix payment", "money"),
  none("where's the money I spent last night", "money"),
  none("how much did I spend in the evenings", "money"),
  none("my balance is giving me a headache", "money"),
  none("I forgot when my bill is due", "money"),
  none("show me what I bought at Tesco", "money"),
  none("did I get charged twice", "money"),
  none("why is my bill so high", "money"),
  none("I don't recognise this transaction", "money"),
  none("can I pay my bill now", "money"),
  none("what's my available credit", "money"),
  none("how much do I spend on food", "money"),
  none("I want to set a budget", "money"),

  // Direct commands: the precise rules handle these, so the situation layer must stay out of the way
  none("make the writing larger", "command"),
  none("switch to dark mode please", "command"),
  none("bigger buttons please", "command"),
  none("turn the contrast up", "command"),
  none("go to my spending", "command"),
  none("make the text smaller", "command"),
  none("hide the spending chart", "command"),
  none("take me home", "command"),
  none("show me more detail", "command"),
  none("read it out loud", "command"),

  // Negated: the person is saying this is NOT their situation
  none("I'm not colour blind", "negated"),
  none("I don't have dyslexia", "negated"),
  none("I'm not deaf, just busy", "negated"),
  none("I am not blind", "negated"),

  // Small talk
  none("hello there", "chat"),
  none("thanks Dial", "chat"),
  none("what's the weather like", "chat"),
  none("tell me a joke", "chat"),
];

/**
 * Blind test set: written after the development round and never used to change the catalogue or the thresholds.
 * This is the number to quote.
 */
export const TEST_SET: EvalCase[] = [
  s("it's the evening and I can hardly read this", ["night_vision"], "night"),
  s("my eyes really struggle with screens at night", ["night_vision"], "night"),
  s("in the dark the app is impossible to read", ["night_vision"], "night"),
  s("when I'm in bed at night the text is too hard to see", ["night_vision"], "night"),
  s("my sight is failing", ["low_vision"]),
  s("I've got really bad eyes", ["low_vision"]),
  s("I can't read small fonts", ["low_vision"]),
  s("I'm visually impaired and need big text", ["low_vision"]),
  s("I'm completely blind", ["screen_reader"]),
  s("I use voice over on my iPhone", ["screen_reader"]),
  s("I can't see, so please talk to me", ["screen_reader"]),
  s("I'm red-green colourblind", ["colour_vision"]),
  s("colours all look similar to me", ["colour_vision"]),
  s("I can't see which bits are red", ["colour_vision"]),
  s("I'm dyslexic so lots of text is hard", ["reading"]),
  s("reading has always been hard for me", ["reading"]),
  s("my reading isn't great", ["reading"]),
  s("I have a tremor in my hands", ["dexterity"]),
  s("my fingers don't do what I want", ["dexterity"]),
  s("arthritis makes tapping painful", ["dexterity"]),
  s("I accidentally press buttons twice", ["dexterity"]),
  s("I'm using one hand because I'm holding my kid", ["one_handed"]),
  s("one hand only right now", ["one_handed"], "now"),
  s("my right arm is in a sling", ["one_handed"]),
  s("I'm sitting in bright sunshine", ["bright_light"]),
  s("the sun's glaring on my screen", ["bright_light"]),
  s("I get really bad migraines from screens", ["light_sensitivity"]),
  s("anything flashing makes me ill", ["light_sensitivity"]),
  s("bright colours hurt my eyes and give me headaches", ["light_sensitivity"]),
  s("I have attention problems", ["focus"]),
  s("I get easily overwhelmed by cluttered screens", ["focus"]),
  s("it's hard for me to stay focused", ["focus"]),
  s("my memory's not what it was", ["memory"]),
  s("I have early dementia", ["memory"]),
  s("I tend to forget what I've just done", ["memory"]),
  s("money makes me so anxious", ["money_anxiety"]),
  s("I'm frightened of seeing my balance", ["money_anxiety"]),
  s("I get stressed out by numbers", ["money_anxiety"]),
  s("I'm hard of hearing", ["hearing"]),
  s("I can't hear the speaker very well", ["hearing"]),
  s("I'm deaf in both ears", ["hearing"]),
  s("you're talking too fast for me", ["slow_speech"]),
  s("slower please, I can't follow", ["slow_speech"]),
  s("my first language is Polish", ["second_language"]),
  s("I don't understand English very well", ["second_language"]),
  s("I'm dyslexic and I also have a tremor", ["reading", "dexterity"], undefined, "mixed"),
  s("I can't see well at night and I get anxious about money", ["night_vision", "money_anxiety"], "night", "mixed"),
  s("I'm hard of hearing and colour blind", ["hearing", "colour_vision"], undefined, "mixed"),
  s("i got shaky hands", ["dexterity"], undefined, "typo"),
  s("im dislexic", ["reading"], undefined, "typo"),
  s("cant see at nite", ["night_vision"], "night", "typo"),
  s("colour blnd", ["colour_vision"], undefined, "typo"),
  none("I can't see the payment I made yesterday", "money"),
  none("how much did I spend last night", "money"),
  none("I forgot what my credit limit is", "money"),
  none("my bill makes no sense", "money"),
  none("show me the refund", "money"),
  none("pay the minimum", "money"),
  none("where did I spend the most", "money"),
  none("make it bigger", "command"),
  none("dark theme please", "command"),
  none("more contrast", "command"),
  none("open spend pause", "command"),
  none("show detailed view", "command"),
  none("I'm not colour blind, I just want a summary", "negated"),
  none("I don't have arthritis", "negated"),
  none("good morning", "chat"),
  none("who made you", "chat"),
];
