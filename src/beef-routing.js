// language: JavaScript, file: src/beef-routing.js
//
// The beef path's decisions, in the client, with nothing to talk to.
//
// On the control server these live in the bot's `triggers.js`, next to a Discord
// connection and a config file. This is the same reasoning ported out of that
// context: what counts as being pinged, how hard a message is coming at us, which
// door a message goes through (a beef, the answer to an opener we armed, or
// nothing), whether an afk check is a question or somebody starting something, how
// a line should be answered with an emoji, and which line of a room is worth
// quoting back. The client's beef page needs all of that to read a line and to say
// what the bot would do with it, and it needs it *without* a bot running.
//
// Three rules hold the port together:
//
//   * **no imports at all.** Not one: this file is pure data and pure functions, so
//     it can be evaluated in a page, in a test, in the main process, or on a phone
//     without a module loader. That is also why the one class here that would have
//     touched the filesystem (`TargetMemory`) is handed its `io` instead of
//     requiring `node:fs`;
//   * **the tunables live in one objected, exported as `DEFAULT_CONFIG`.** A
//     function whose defaults come from that set takes it as its last argument,
//     named `config`, so a caller can change the numbers in one place. Every
//     default in it is the value the bot already used, which is what makes the
//     same call produce the same answer here as it does there;
//   * **behaviour is copied, not reinterpreted.** The cue classes, the guards, the
//     thresholds, the clamps and the exact wording of every reason string are the
//     bot's. Where a function reads a live Discord message upstream, it takes a
//     plain object with the same field names here (`content`, `authorId`,
//     `replyTo`, `ts`, `text`) and says so. Nothing here is a guess about what the
//     bot does: it is the bot's own reasoning, lifted.
//
// Roll, random and now are all injectable (`opts.roll`, `rng`, `opts.now`) so a
// test can drive a decision to a known answer instead of hoping for one.

/* ---- the cue vocabulary -------------------------------------------------- */

export const INSULT_CUES = [
  "fuck", "shit", "cunt", "bitch", "slut", "ass", "pussy", "dick", "fag", "dyke",
  "nigger", "nigga", "coon", "retard", "faggot", "kys", "kill yourself", "trash",
  "mid", "ratio", "loser", "idiot", "stupid", "dumb", "suck", "garbage", "dogshit",
  "clown", "bozo", "npc", "bum", "fraud", "goofy", "crybaby", "dogwater", "shitter", "muppet",
  "worthless", "pathetic", "embarrassing", "peasant", "washed up",
  "bum ass", "dusted", "flopped", "bricked", "jobless", "maidenless", "negative aura", "weak aura",
];

export const GREET = ["hi", "hey", "hello", "yo", "sup", "wassup", "whats up", "what’s up", "heya", "hiya", "ello", "gm", "gn", "morning", "evening", "yo yo"];
export const LAUGH = ["lol", "lmao", "lmfao", "haha", "hahaha", "rofl", "😂", "💀", "lul", "lolol", "hehe", "kek", "kekw", "pfft", "hah"];
export const AGREE = ["true", "facts", "real", "fr", "ong", "valid", "fair", "bet", "fax", "no cap", "big facts"];
export const THANKS = ["thanks", "thank you", "ty", "thx", "appreciate"];
export const APOLOGY = ["sorry", "my bad", "mb", "apologies"];
export const CONFUSED = ["what", "huh", "?", "wtf", "wth", "how", "why", "huh?", "??", "wut", "wat"];
export const BRB = ["brb", "afk", "gtg", "gotta go", "be right back"];
export const STOP = ["stop", "stop please", "pause", "leave me alone", "shut up", "stfu"];

export const GAME_WORDS = ["rank", "elo", "aim", "kd", "clutch", "round", "match", "lobby", "smurf", "hardstuck", "valorant", "league", "cs2", "fortnite", "apex"];
export const BOT_WORDS = ["bot", "script", "ai", "chatgpt", "automated", "selfbot", "automod"];

/**
 * Cues live in weighted classes rather than one flat list, because severity comes
 * from what was actually said: a death threat is not the same message as "mid".
 * The classes are pushed one at a time upstream, and the order is load-bearing -
 * the first class that claims a cue keeps it (see CUE_MAP below), so "trash"
 * weighs what the insult class says it weighs even though other classes repeat it.
 */
export const CUE_CLASSES = [
  {
    name: "nuclear",
    weight: 5,
    cues: ["kys", "k y s", "kill yourself", "kill urself", "end yourself", "neck yourself", "rope yourself", "hope you die"],
  },
  {
    name: "threat",
    weight: 3,
    cues: ["ill end you", "i will end you", "youre done", "you are done", "your done", "watch your back", "ima find you"],
  },
  {
    name: "insult",
    weight: 2,
    cues: [
      "fuck", "shit", "cunt", "bitch", "ass", "pussy", "dick", "fag", "faggot", "dyke", "nigga", "nigger",
      "coon", "retard", "trash", "loser", "idiot", "stupid", "dumb", "suck", "dogshit", "garbage", "washed", "hardstuck",
    ],
  },
  {
    name: "dismiss",
    weight: 2,
    cues: [
      "nobody asked", "no one asked", "who asked", "nobody cares", "shut up", "stfu", "cry about it", "cry more",
      "get a life", "touch grass", "get a job", "quit", "obsessed with me", "yapping", "yapper", "tldr", "tl;dr", "not reading that",
      "cool story", "ok and", "so what", "who cares", "didnt ask", "still talking", "talk to the hand",
    ],
  },
  {
    name: "mock",
    weight: 1,
    cues: [
      "cope", "seethe", "malding", "mald", "ratio", "skill issue", "rent free", "brainrot", "brain rot",
      "ur bad", "youre bad", "you are bad", "ur trash", "you are trash", "weirdo", "creep", "mid", "soft",
      "finished", "irrelevant", "pressed", "fragile", "corny", "cringe", "tryhard", "delusional", "cooked",
      "smoked", "copium", "braindead", "regarded", "smoothbrain", "clown", "bozo", "goofy", "muppet",
      "peaked", "meltdown", "shook", "npc", "bum", "fraud", "dogwater",
      "buns", "cheeks", "dusted", "flopped", "bricked", "yikes", "oof", "owned", "weak aura", "negative aura",
      "sorry excuse", "participation trophy", "background character",
    ],
  },
  {
    name: "botaccuse",
    weight: 1,
    cues: ["bot", "script", "scripted", "ai", "chatgpt", "automated", "selfbot", "automod"],
  },
];

// the newer angles: baiting, exclusion, reporting, grief-trolling, spam masks,
// thirst, promo, authority claims and condescension
CUE_CLASSES.push(
  {
    name: "bait",
    weight: 1,
    cues: [
      "u mad", "you mad", "ur mad", "triggered", "triggered?", "so triggered", "dare u", "dare you",
      "say it again", "reply if u can", "reply if you can", "u wont reply", "you wont reply",
      "im baiting", "baiting u", "easy bait", "get baited", "still here?", "u still here",
      "type something", "say something then", "got u mad", "why u typing", "why are u typing", "u mad bro", "cry harder", "stay mad", "cope harder", "seethe more",
      "still typing", "keep typing", "type less", "say less", "talk less", "u done", "are u done", "u finished",
    ],
  },
  {
    name: "exclusion",
    weight: 2,
    cues: [
      "nobody wants u here", "nobody wants you here", "not welcome", "leave the server", "leave this server",
      "who invited u", "who invited you", "get out of here", "gtfo", "nobody likes u", "nobody likes you",
      "everyone hates u", "everyone hates you", "we all hate u", "unwanted", "nobody here asked",
      "blocked me?", "im blocking u", "blocking you", "muted u", "muting you",
    ],
  },
  {
    name: "report",
    weight: 1,
    cues: [
      "reported u", "reported you", "im reporting", "reporting u", "reporting you", "get banned",
      "u will be banned", "you will be banned", "getting banned", "reported to staff", "mods are watching",
      "screenshotted", "screen shotted", "sending this to mods", "im telling the mods", "ad', ",
    ],
  },
  {
    name: "grieftroll",
    weight: 1,
    cues: [
      "spamming", "ur spamming", "stop spamming", "rage quit", "ragequit", "u raged", "you raged",
      "u tilted", "you tilted", "cope harder", "seethe harder", "crying about it", "still crying",
      "log off", "go offline", "delete ur account", "delete your account", "uninstall",
    ],
  },
);

CUE_CLASSES.push(
  { name: "spam", weight: 1, cues: [
    "stop spamming", "flooding the chat", "copy paste", "copy pasting",
    "same message", "stop pasting", "posting that again", "nobody reads that",
  ] },
  { name: "thirst", weight: 2, cues: [
    "send pics", "send nudes", "be my gf", "be my girlfriend", "simp",
    "thirsty", "dm me baby", "love u baby", "marry me", "so hot",
  ] },
  { name: "promo", weight: 1, cues: [
    "join my server", "join my discord", "check out my", "sub to me",
    "follow my", "dms open", "free nitro", "nitro drop", "click the link",
  ] },
  { name: "authority", weight: 1, cues: [
    "im a mod", "i am a mod", "mod here", "owner said", "staff said",
    "my friend is admin", "i own this", "im the owner", "i run this",
  ] },
  { name: "condescend", weight: 1, cues: [
    "sweetie", "little man", "go to bed", "whose kid is this",
    "calm down son", "know your place", "stay in your lane", "arent you new",
  ] },
);

CUE_CLASSES.push(
  {
    name: "duel",
    weight: 2,
    cues: [
      "fight me", "1v1 me", "1v1", "square up", "run it", "wanna fight", "lets fight",
      "catch a fade", "fade me", "duel me", "throw hands", "come outside",
    ],
  },
);

/** cue -> { name, weight }: the first class that claims a cue keeps it */
export const CUE_MAP = new Map();
for (const group of CUE_CLASSES) {
  for (const cue of group.cues) if (!CUE_MAP.has(cue)) CUE_MAP.set(cue, { name: group.name, weight: group.weight });
}
export const NUCLEAR_CUES = CUE_CLASSES[0].cues;
export const AGGRO_CUES = [...CUE_MAP.keys()];

// guards - the cue is quoted, denied, about someone else, or wrapped in manners
const QUOTED = /(^|\s)>|(^|\s)quote:/;
const DENIED = [
  /\bno ?one said/, /\bnobody said/, /\bdidnt (say|call|mean)/, /\bnot (saying|said|mean)/,
  /\bnever said/, /\bwho said/, /\bwhat do you mean/, /\bare you ok/, /\basking for a friend/,
];
const POLITE = [
  /\bplease\b/, /\bthank/, /\bthx\b/, /\bty\b/, /\bappreciate/, /\blove (you|u|ya)\b/,
  /\bgood (luck|game|one)\b/, /\bgg\b/, /\bsorry\b/, /\bmy bad\b/, /\bno pressure\b/,
];
const THIRD_PARTY = [/\b(he|she|they|him|her|them|that (guy|kid|one|dude)|those two)\b/];
const SECOND_PERSON = [/\b(you|u|ur|your|youre|yall|yall're)\b/];

/** the tunables, in one place. Every value is the bot's own default. */
export const DEFAULT_CONFIG = {
  // aggro: the field names are the control server's config keys
  aggro_lock: "on",
  aggro_cooldown_ms: 20000,
  aggro_burst_min: 2,
  aggro_burst_max: 7,
  aggro_ignore: "",
  // the afk call
  afk_quiet_ms: 45000,
  afk_answer_max: 6,
  afk_stale_thread_ms: 20 * 60 * 1000,
  afk_escalate_at: 4,
  afk_break_silence_at: 4,
  afk_cadence_fast_ms: 20000,
  afk_check_window_ms: 10 * 60 * 1000,
  // a mob, and the same hands starting again
  mob_window_ms: 45000,
  starter_window_ms: 60 * 60 * 1000,
  storm_window_ms: 60000,
  storm_distinct: 3,
  // an armed "<@target> fight me" only stays armed this long
  arm_ms: 120000,
  // what per-channel memory and per-person memory keep
  context_limit: 12,
  context_max_age_ms: 180000,
  memory_max: 400,
  memory_jokes: 8,
  memory_starts: 20,
  memory_save_debounce_ms: 2000,
};

/* ---- reading a line ------------------------------------------------------ */

export function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/<@!?\d+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_~`|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is a cue really there as a word (with the usual endings) instead of hiding
 * inside a longer one? "ai" must not fire on "said", "ass" must not fire on
 * "class", "mid" must not fire on "midnight". Phrases and long cues match as-is.
 */
export function cueHit(text, cue) {
  const raw = String(cue || "").toLowerCase().trim();
  if (!raw) return false;
  const hay = String(text || "").toLowerCase();
  if (!hay.includes(raw)) return false;
  if (raw.includes(" ") || /[^a-z0-9]/.test(raw) || raw.length > 6) return true;
  // only plain alphanumeric cues get here, so there is nothing to escape
  return new RegExp("(^|[^a-z0-9])" + raw + "(s|es|ed|ing|er|ers|y|head|heads|ass)?($|[^a-z0-9])").test(hay);
}

export function smartTopic(text, history = []) {
  const blob = [text, ...history.slice(-4)].map(normalize).join(" ");
  if (BOT_WORDS.some((w) => cueHit(blob, w))) return "bot";
  if (GAME_WORDS.some((w) => cueHit(blob, w))) return "game";
  if (INSULT_CUES.some((w) => cueHit(blob, w))) return "insult";
  return "";
}

/**
 * Light intent, from the line alone. The order of the tests is the bot's, and it
 * matters: "stop" before greetings, laughter before agreement, the nuclear cue
 * before a plain insult, and the shapes people actually bait in last.
 */
export function detectIntent(text) {
  const t = normalize(text);
  if (!t) return "empty";
  if (STOP.some((s) => t === s || t.startsWith(s + " "))) return "stop";
  if (BRB.some((s) => t.includes(s))) return "brb";
  if (GREET.some((s) => t === s || t.startsWith(s + " "))) return "greet";
  if (LAUGH.some((s) => t.includes(s))) return "laugh";
  if (AGREE.some((s) => t === s || t.startsWith(s + " "))) return "agree";
  if (THANKS.some((s) => t.includes(s))) return "thanks";
  if (APOLOGY.some((s) => t.includes(s))) return "apology";
  if (CONFUSED.some((s) => t === s || t.startsWith(s))) return "confused";
  for (const [cue, meta] of CUE_MAP) {
    if (meta.name === "nuclear" && cueHit(t, cue)) return "threat";
  }
  if (INSULT_CUES.some((w) => cueHit(t, w))) return "insult";
  if (/\b(lfg|q up|queue|ranked|duo|scrim|match|valorant|cs2|csgo|minecraft|roblox|fortnite|apex|rank)\b/.test(t)) return "lfg";
  if (/\b(u single|you single|marry me|send pics|send nudes|be my gf|so hot|simp|thirsty|dm me)\b/.test(t)) return "flirt";
  if (/\b(join my server|join my discord|check out my|sub to me|follow my|my server|dms open|free nitro|click the link)\b/.test(t)) return "promo";
  if (/\b(paypal|cashapp|venmo|crypto|gift card|steam card|chargeback)\b/.test(t)) return "money";
  if (/\b(alt|smurf|second account|new acc|throwaway)\b/.test(t)) return "alt";
  if (/\b(depressed|lonely|tired|exhausted|cant sleep|hate my life|no friends)\b/.test(t)) return "sad";
  for (const [cue, meta] of CUE_MAP) {
    if (meta.name === "mock" && t.includes(cue)) return "mock";
  }
  if (/\b(u|you|ur|youre) (mad|triggered|pressed)\b/.test(t)) return "bait";
  if (/\b(im|i am) better than (u|you)\b/.test(t) || /\bi (won|win|own) (this|u|you)\b/.test(t)) return "brag";
  if (/\b(nice|great|wow|congrats|congratulations|well done)\b/.test(t) && /\b(genius|einstein|rocket scientist|professor)\b/.test(t)) return "sarcasm";
  if (t.includes("?") || t.startsWith("why") || t.startsWith("how")) return "question";
  if (t === t.toUpperCase() && t.length > 8 && /[A-Z]/.test(text)) return "shout";
  return "chat";
}

/** Was this message aimed at us? (works on the raw text, mentions included) */
export function isPing(content, selfId) {
  const text = String(content || "");
  return text.includes("<@" + selfId + ">") || text.includes("<@!" + selfId + ">");
}

/** shout / emphasis / elongation, measured on the raw text */
export function intensityOf(raw) {
  const text = String(raw || "");
  const letters = text.replace(/[^A-Za-z]/g, "");
  const caps = text.replace(/[^A-Z]/g, "").length;
  const shout = letters.length >= 8 && caps / letters.length >= 0.7;
  const emphasis = /!{2,}/.test(text) || /\?{2,}/.test(text);
  const elongated = /([a-z])\1{2,}/i.test(text);
  const long = letters.length >= 80;
  return { shout, caps, emphasis, elongated, long };
}

/**
 * How hard a message is coming at us: 0 = nothing, 1 = aggro, 2 = loud/repeat,
 * 3 = nuclear. A ping counts when it is aimed at us (mention or a reply to one
 * of our messages) AND carries a cue, or is shouted straight at us. Quoting,
 * denying, talking about someone else and plain manners all step it back down.
 *
 * `opts` is the plain-object shape of what a live message would give us:
 * `{ mentioned, selfId, repliedToUs, names }`.
 */
export function detectAggro(content, opts = {}) {
  const raw = String(content || "");
  const bare = raw.replace(/<@!?\d+>/g, " ").replace(/<@&\d+>/g, " ");
  const clean = normalize(bare);
  const mentioned = opts.mentioned != null ? Boolean(opts.mentioned) : isPing(raw, opts.selfId);
  const repliedToUs = Boolean(opts.repliedToUs);
  const mentions = (bare.match(/<@!?[0-9]+>/g) || []).length;
  const names = Array.isArray(opts.names) ? opts.names : [];
  const named =
    clean.length > 0 &&
    names.some((n) => {
      const needle = String(n || "").trim().toLowerCase();
      if (needle.length < 3) return false;
      const safe = needle.replace(new RegExp("[.*+?^$()|[\\]{}]", "g"), "\\$&");
      return new RegExp("(^|[^a-z0-9])" + safe + "($|[^a-z0-9])").test(clean);
    });
  const cues = [];
  const classes = new Set();
  let score = 0;
  for (const [cue, meta] of CUE_MAP) {
    if (!cueHit(clean, cue)) continue;
    cues.push(cue);
    classes.add(meta.name);
    score += meta.weight;
    if (score > 6) score = 6; // a wall of cues is not worse than a death threat
  }
  // naming us on top of a cue is aimed at us, the same way a ping is
  const directed = mentioned || repliedToUs || (named && score > 0);

  const intensity = intensityOf(bare);
  const words = clean ? clean.split(" ").length : 0;
  const quoted = QUOTED.test(clean);
  const denied = DENIED.some((re) => re.test(clean));
  const polite = POLITE.some((re) => re.test(clean));
  const thirdParty = words > 6 && THIRD_PARTY.some((re) => re.test(clean)) && !SECOND_PERSON.some((re) => re.test(clean));

  let adjusted = score;
  if (quoted) adjusted -= 4;
  if (denied) adjusted -= 3;
  if (thirdParty) adjusted -= 2;
  if (polite) adjusted -= 1;
  if (intensity.emphasis) adjusted += 1;
  if (intensity.elongated) adjusted += 0.5;
  if (mentions > 1) adjusted += 1; // several pings in one message is a push, not a question

  let level = 0;
  if (adjusted >= 5) level = 3;
  else if (adjusted >= 3) level = 2;
  else if (adjusted >= 1) level = 1;
  const nuclear = classes.has("nuclear") && !denied && !quoted;
  if (nuclear) level = 3;
  if (directed && intensity.shout && level < 2 && !quoted && !denied && !polite) level = 2;

  const aggro = directed && level > 0;
  return {
    aggro,
    level: aggro ? Math.max(1, level) : 0,
    score: adjusted,
    directed,
    mentioned,
    repliedToUs,
    named,
    mentions,
    cues: cues.slice(0, 6),
    classes: [...classes],
    shout: intensity.shout,
    emphasis: intensity.emphasis,
    elongated: intensity.elongated,
    quoted,
    denied,
    polite,
    thirdParty,
    nuclear,
    text: clean,
  };
}

/**
 * The aggro behaviour, read fresh on every ping so a dashboard edit applies at
 * once. Everything is clamped here rather than at the call site. `config` is the
 * same config object the bot read (`aggro_lock`, `aggro_cooldown_ms`,
 * `aggro_burst_min/max`, `aggro_ignore`).
 */
export function aggroSettings(config = DEFAULT_CONFIG) {
  const raw = config || {};
  const enabled = String(raw.aggro_lock == null ? "on" : raw.aggro_lock).toLowerCase() !== "off";
  // 0 must survive as 0 (a bare `|| default` would silently promote it).
  const num = (v, d) => {
    if (v === null || v === undefined || v === "") return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const cooldownMs = Math.round(Math.max(2000, Math.min(600000, num(raw.aggro_cooldown_ms, 20000))));
  const min = Math.round(Math.max(1, Math.min(8, num(raw.aggro_burst_min, 2))));
  const max = Math.round(Math.max(min, Math.min(8, num(raw.aggro_burst_max, 7))));
  const ignore = new Set(
    String(raw.aggro_ignore || "")
      .split(/[,\s]+/)
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return { enabled, cooldownMs, min, max, ignore };
}

/**
 * The one engagement question, shared by the reply gate and the beef gate so the
 * two can never disagree about whether a message is ours. `input` is the plain
 * object shape of a message: `{ content, selfId, authorId, active, targetId, ... }`.
 */
export function shouldEngage(input = {}) {
  const { content, selfId, authorId, keywords = [], active, targetId, mentionRequired = false } = input;
  const text = content || "";
  const mentioned = text.includes(`<@${selfId}>`) || text.includes(`<@!${selfId}>`);
  const low = normalize(text);
  const kw = (keywords || []).map((k) => k.toLowerCase()).filter(Boolean);
  const keywordHit = kw.some((k) => {
    // whole-ish word
    const re = new RegExp(`(?:^|\\s)${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\s|[.,!?])`, "i");
    return re.test(low) || low === k;
  });

  if (Number(authorId) === Number(selfId)) return { engage: false, reason: "self" };

  // already locked on this target
  if (active && targetId && Number(authorId) === Number(targetId)) {
    return { engage: true, reason: "target", mentioned, keywordHit };
  }

  if (mentioned && detectAggro(text, { mentioned: true, selfId }).aggro) {
    return { engage: true, reason: "mention+aggro", mentioned, keywordHit };
  }
  if (mentioned && (low.includes("?") || low.length > 10)) {
    return { engage: true, reason: "mention+intent", mentioned, keywordHit };
  }
  if (keywordHit && (INSULT_CUES.some((w) => low.includes(w)) || low.length > 8)) {
    return { engage: true, reason: "keyword", mentioned, keywordHit };
  }
  if (mentioned && !mentionRequired && low.length > 0) {
    // soft mention with any text
    return { engage: true, reason: "mention", mentioned, keywordHit };
  }
  return { engage: false, reason: "none", mentioned, keywordHit };
}

/* ---- per-channel memory -------------------------------------------------- */

/**
 * The last few lines per channel, with their intent and topic, so a reply knows
 * what the room has been saying. In memory only, and deliberately small: 12
 * entries per channel and 32 channels.
 */
export class ContextWindow {
  constructor({ limit = DEFAULT_CONFIG.context_limit, maxAgeMs = DEFAULT_CONFIG.context_max_age_ms } = {}, config = DEFAULT_CONFIG) {
    this.limit = Math.max(1, Math.floor(Number(limit) || Number(config.context_limit) || 12));
    this.maxAgeMs = Math.max(1000, Number(maxAgeMs) || Number(config.context_max_age_ms) || 180000);
    this.byChannel = new Map(); // channelId -> [{authorId, text, ts, intent, topic}]
  }

  push(channelId, entry) {
    const id = String(channelId);
    let arr = this.byChannel.get(id) || [];
    arr.push({ ...entry, ts: entry.ts || Date.now() });
    if (arr.length > this.limit) arr = arr.slice(-this.limit);
    this.byChannel.set(id, arr);
    // cap channels
    if (this.byChannel.size > 32) {
      const first = this.byChannel.keys().next().value;
      this.byChannel.delete(first);
    }
  }

  recent(channelId, authorId = null) {
    const now = Date.now();
    const arr = (this.byChannel.get(String(channelId)) || []).filter((e) => now - e.ts <= this.maxAgeMs);
    if (authorId != null) return arr.filter((e) => String(e.authorId) === String(authorId));
    return arr;
  }

  topicFor(channelId, authorId) {
    const lines = this.recent(channelId, authorId).map((e) => e.text);
    return smartTopic("", lines);
  }

  lastIntent(channelId, authorId) {
    const lines = this.recent(channelId, authorId);
    return lines.length ? lines[lines.length - 1].intent : "";
  }
}

/* ---- what a soft intent earns -------------------------------------------- */

export const REPLIES = {
  greet: ["yo", "sup", "hey", "what u want", "speak"],
  laugh: ["funny?", "ok", "sure", "mid joke", "that all"],
  agree: ["at least u got that right", "even a broken clock", "ok and", "cool"],
  thanks: ["dont thank me", "whatever", "ok"],
  apology: ["didnt ask", "still mid", "apology not accepted"],
  confused: ["figure it out", "not my problem", "read slower", "nah"],
  brb: ["run then", "dont come back", "clock starts now"],
  question: ["figure it out", "why would i know", "ask better", "idk care less"],
  shout: ["all caps and still soft", "volume aint pressure", "calm down"],
  lfg: ["queue up then", "lobby is that way", "good luck u need it", "ill be in ranked while u load"],
  flirt: ["not interested", "aim that at someone who asked", "down bad in a beef", "keep it moving"],
  promo: ["nobody clicking that", "self promo in a beef is wild", "wrong channel", "advertising free of charge huh"],
  money: ["scam radar on", "nobody sending you anything", "wrong guy for that pitch", "blocked that"],
  alt: ["alt detected", "new account same L", "smurf energy", "still losing on the alt"],
  sad: ["we all tired", "not a therapy session", "cry about it later", "cool story"],
};

// every reply class has its own shape, and a game thread answers differently
const REPLY_SHAPES = {
  money: {
    lines: ["wrong guy for that", "nobody here is sending you money", "scam radar says no", "try a bank"],
  },
  promo: {
    lines: ["nobody is clicking that", "advertise where someone cares", "self promo in here is sad", "wrong channel for that"],
    game: ["your server has three bots and you", "nobody is joining that", "promo in a lobby is wild"],
  },
  sad: {
    lines: ["we are all tired", "not a therapy session", "cool story", "log off and sleep then"],
  },
  flirt: {
    lines: ["not interested", "aim that at someone who asked", "down bad in a chat", "keep it moving"],
  },
  alt: {
    lines: ["alt detected", "new account same L", "smurf energy", "still losing on the alt"],
  },
  lfg: {
    lines: ["queue up then", "the lobby is that way", "good luck, you need it", "ill be in ranked while you load"],
    game: ["what are we playing", "rank first then talk", "queue or keep talking", "run it then"],
  },
};

// the same soft intent reads differently when the thread is about a game
const REPLIES_GAME = {
  greet: ["sup, queue?", "yo, what are we playing", "hey, ranked?"],
  question: ["work out the meta yourself", "ask the wiki", "idk, queue and find out"],
  laugh: ["funny, now queue", "ok now load in", "lol, game?"],
  thanks: ["dont thank me, queue", "whatever, load in"],
};

/**
 * The reply a soft intent earns, or null when the line belongs to the beef
 * generator instead. `roll` decides both whether there is a reply at all and
 * which one, so a test can ask for a specific one.
 */
export function contextualReply(intent, topic, name = "", roll) {
  if (intent === "stop") return null; // handled by caller
  const t = String(topic || "").toLowerCase();
  const r = Number.isFinite(Number(roll)) ? Number(roll) : Math.random();
  const shape = REPLY_SHAPES[intent];
  if (shape) {
    // money, promos, vents, flirting and alts each always answer in their own shape
    const bank = t === "game" && shape.game ? shape.game : shape.lines;
    let line = bank[Math.floor(r * bank.length) % bank.length];
    if (name && r > 0.7) line = line + " " + name;
    return line;
  }
  if (!REPLIES[intent]) return null; // fall through to the beef generator
  if (r >= 0.75) return null;
  const bank = t === "game" && REPLIES_GAME[intent] ? REPLIES_GAME[intent] : REPLIES[intent];
  let line = bank[Math.floor((r / 0.75) * bank.length) % bank.length];
  if (name && r > 0.7) line = line + " " + name;
  return line;
}

/** a line worth remembering: two words or more, short, and not an insult */
export function harvest(text) {
  const t = normalize(text);
  if (!t || t.split(" ").length < 2) return null;
  if (t.length > 120) return null;
  if (INSULT_CUES.some((w) => t.includes(w))) return null;
  return t;
}

/* ---- what we remember about a person ------------------------------------ */

export const MEMORY_MAX = DEFAULT_CONFIG.memory_max;
export const MEMORY_JOKES = DEFAULT_CONFIG.memory_jokes;
export const MEMORY_STARTS = DEFAULT_CONFIG.memory_starts;

/** the shape of somebody we have never met */
function blankPerson() {
  return {
    topics: new Set(), phrases: [], jokes: [], starts: [], grudges: 0, lastTier: "", hits: 0, lastTs: 0,
    // how they check us: seen, answered, left alone, and when, plus the run of
    // times we stayed quiet and how far apart their checks land. The per-person
    // quirk the afk call reads.
    afk: 0, afkAnswered: 0, afkQuiet: 0, afkLast: 0,
    afkStreak: 0, afkGapMs: 0,
  };
}

/**
 * What we remember about each person: the topics they bring up, the lines they
 * keep repeating (running jokes we can bring back up), how many times they have
 * started on us, and how they check us.
 *
 * The bot reads and writes a file here. This module imports nothing, so the caller
 * hands the storage in: `io = { read(file) -> string|null, write(file, text) ->
 * boolean }`. With no `io` the memory lives for the session and `save()` says so
 * by returning false, which is the honest answer rather than a silent forget. The
 * text written is byte-for-byte the shape the bot writes, so the same file can be
 * read by either side.
 */
export class TargetMemory {
  constructor({ file = "", io = null, config = DEFAULT_CONFIG } = {}) {
    this.map = new Map();
    this.file = String(file || "");
    this.io = io;
    this.lastSave = 0;
    this.max = Math.max(1, Math.floor(Number(config.memory_max) || MEMORY_MAX));
    this.maxJokes = Math.max(1, Math.floor(Number(config.memory_jokes) || MEMORY_JOKES));
    this.maxStarts = Math.max(1, Math.floor(Number(config.memory_starts) || MEMORY_STARTS));
    this.debounceMs = Math.max(0, Number(config.memory_save_debounce_ms) || 0);
    this.load();
  }

  touch(authorId, { topic, phrase } = {}) {
    const id = String(authorId);
    const now = Date.now();
    let e = this.map.get(id);
    if (!e) e = blankPerson();
    e.hits += 1;
    e.lastTs = now;
    if (topic) e.topics.add(topic);
    if (phrase) {
      const low = phrase.toLowerCase().slice(0, 80);
      e.phrases.push(low);
      if (e.phrases.length > 20) e.phrases.shift();
      // a line they keep saying is a running joke, not a one-off
      const seen = e.jokes.find((j) => j.text === low);
      if (seen) {
        seen.count += 1;
        seen.lastAt = now;
      } else {
        e.jokes.push({ text: low, count: 1, lastAt: now });
        if (e.jokes.length > this.maxJokes) e.jokes.shift();
      }
    }
    this.map.set(id, e);
    this.save();
    return e;
  }

  info(authorId) {
    return this.map.get(String(authorId)) || blankPerson();
  }

  /** the line they repeat most, once it has actually been repeated */
  runningJoke(authorId) {
    const jokes = this.info(authorId).jokes || [];
    const twice = jokes.filter((j) => j.count >= 2);
    const pool = twice.length ? twice : [];
    if (!pool.length) return "";
    return pool.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)[0].text;
  }

  /** how many times they started on us inside the window (restart or not) */
  startsWithin(authorId, now = Date.now(), windowMs = DEFAULT_CONFIG.starter_window_ms) {
    const { starts } = this.info(authorId);
    return (starts || []).filter((ts) => now - ts <= windowMs).length;
  }

  recordStart(authorId, { now = Date.now(), tier = "", source = "" } = {}) {
    const id = String(authorId);
    const e = this.map.get(id) || blankPerson();
    e.starts.push(now);
    if (e.starts.length > this.maxStarts) e.starts = e.starts.slice(-this.maxStarts);
    e.lastTier = String(tier || e.lastTier || "");
    e.lastSource = String(source || e.lastSource || "");
    this.map.set(id, e);
    this.save();
    return this.startsWithin(id, now);
  }

  /**
   * What kind of checker this person is: how often they check us, how much of
   * that we answered, and how much they got silence for. The afk call reads this
   * back, so the tenth check from somebody is judged differently to the first.
   */
  noteAfk(authorId, { answered = false, quiet = false, now = Date.now(), gapMs } = {}) {
    const id = String(authorId);
    const e = this.map.get(id) || blankPerson();
    e.afk = Math.max(0, Math.floor(Number(e.afk) || 0)) + 1;
    if (answered) e.afkAnswered = Math.max(0, Math.floor(Number(e.afkAnswered) || 0)) + 1;
    if (quiet) e.afkQuiet = Math.max(0, Math.floor(Number(e.afkQuiet) || 0)) + 1;
    // the run of checks we left alone since the last one we answered, and how
    // far apart their checks land: the cadence the afk call reads back
    e.afkStreak = answered ? 0 : Math.max(0, Math.floor(Number(e.afkStreak) || 0)) + 1;
    const gap = Number(gapMs);
    if (Number.isFinite(gap) && gap > 0) {
      const prev = Number(e.afkGapMs) || 0;
      e.afkGapMs = prev ? Math.round(prev * 0.6 + gap * 0.4) : Math.round(gap);
    }
    e.afkLast = Number(now) || Date.now();
    e.lastTs = e.afkLast;
    this.map.set(id, e);
    this.save();
    return { seen: e.afk, answered: e.afkAnswered, quiet: e.afkQuiet, last: e.afkLast, streak: e.afkStreak, gapMs: e.afkGapMs };
  }

  recordGrudge(authorId, { tier = "" } = {}) {
    const id = String(authorId);
    const e = this.map.get(id) || blankPerson();
    e.grudges = Math.max(0, Math.floor(Number(e.grudges) || 0)) + 1;
    if (tier) e.lastTier = String(tier);
    this.map.set(id, e);
    this.save();
    return e.grudges;
  }

  /** one call for the reply path: what do we actually remember about them */
  recall(authorId) {
    const e = this.info(authorId);
    const topics = [...(e.topics || [])];
    return {
      id: String(authorId),
      topic: topics.length ? topics[topics.length - 1] : "",
      topics,
      joke: this.runningJoke(authorId),
      grudges: Math.max(0, Math.floor(Number(e.grudges) || 0)),
      starts: (e.starts || []).length,
      hits: Math.max(0, Math.floor(Number(e.hits) || 0)),
      // their checking quirk: what the afk call weighs before it answers
      afk: Math.max(0, Math.floor(Number(e.afk) || 0)),
      afkAnswered: Math.max(0, Math.floor(Number(e.afkAnswered) || 0)),
      afkQuiet: Math.max(0, Math.floor(Number(e.afkQuiet) || 0)),
      afkLast: Math.max(0, Number(e.afkLast) || 0),
      afkStreak: Math.max(0, Math.floor(Number(e.afkStreak) || 0)),
      afkGapMs: Math.max(0, Math.round(Number(e.afkGapMs) || 0)),
    };
  }

  prune(now = Date.now()) {
    if (this.map.size <= this.max) return 0;
    const rows = [...this.map.entries()].sort((a, b) => (a[1].lastTs || 0) - (b[1].lastTs || 0));
    let dropped = 0;
    while (this.map.size > this.max && rows.length) {
      this.map.delete(rows.shift()[0]);
      dropped += 1;
    }
    void now;
    return dropped;
  }

  load() {
    if (!this.io || !this.file) return this;
    let raw = null;
    try {
      raw = JSON.parse(this.io.read(this.file)) || {};
    } catch {
      /* no file yet, or not ours: start empty rather than refuse to run */
      return this;
    }
    const people = raw && typeof raw.people === "object" ? raw.people : {};
    for (const [id, entry] of Object.entries(people)) {
      if (!entry || typeof entry !== "object") continue;
      this.map.set(String(id), {
        topics: new Set(Array.isArray(entry.topics) ? entry.topics.map(String) : []),
        phrases: Array.isArray(entry.phrases) ? entry.phrases.map(String).slice(-20) : [],
        jokes: Array.isArray(entry.jokes) ? entry.jokes.map((j) => ({ text: String(j.text || ""), count: Number(j.count) || 1, lastAt: Number(j.lastAt) || 0 })).slice(-this.maxJokes) : [],
        starts: Array.isArray(entry.starts) ? entry.starts.map(Number).filter((n) => n > 0).slice(-this.maxStarts) : [],
        grudges: Math.max(0, Math.floor(Number(entry.grudges) || 0)),
        lastTier: String(entry.lastTier || ""),
        lastSource: String(entry.lastSource || ""),
        hits: Math.max(0, Math.floor(Number(entry.hits) || 0)),
        lastTs: Number(entry.lastTs) || 0,
        afk: Math.max(0, Math.floor(Number(entry.afk) || 0)),
        afkAnswered: Math.max(0, Math.floor(Number(entry.afkAnswered) || 0)),
        afkQuiet: Math.max(0, Math.floor(Number(entry.afkQuiet) || 0)),
        afkLast: Math.max(0, Number(entry.afkLast) || 0),
        afkStreak: Math.max(0, Math.floor(Number(entry.afkStreak) || 0)),
        afkGapMs: Math.max(0, Math.round(Number(entry.afkGapMs) || 0)),
      });
    }
    return this;
  }

  save(force = false) {
    if (!this.io || !this.file) return false;
    const now = Date.now();
    if (!force && now - this.lastSave < this.debounceMs) return false; // debounce the hot path
    const people = {};
    for (const [id, e] of this.map) {
      people[id] = {
        topics: [...(e.topics || [])],
        phrases: e.phrases || [],
        jokes: e.jokes || [],
        starts: e.starts || [],
        grudges: e.grudges || 0,
        lastTier: e.lastTier || "",
        lastSource: e.lastSource || "",
        hits: e.hits || 0,
        lastTs: e.lastTs || 0,
        afk: e.afk || 0,
        afkAnswered: e.afkAnswered || 0,
        afkQuiet: e.afkQuiet || 0,
        afkLast: e.afkLast || 0,
        afkStreak: e.afkStreak || 0,
        afkGapMs: e.afkGapMs || 0,
      };
    }
    const ok = this.io.write(this.file, JSON.stringify({ version: 1, savedAt: now, people }, null, 0));
    if (ok) this.lastSave = now;
    return ok === true;
  }

  // prefer angles not used recently
  preferTopic(authorId, detected) {
    const e = this.info(authorId);
    if (detected && !e.topics.has(detected)) return detected;
    const pool = ["insult", "bot", "game", ""].filter((x) => x && !e.topics.has(x));
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    return detected || "insult";
  }
}

/* ---- which door a message goes through ----------------------------------- */

/**
 * What should happen to this message? The message path has three doors - a beef,
 * an armed-fight answer, and the soft reply/activate path - and the order they
 * are tried in is the difference between "fight me" starting a fight and it only
 * waking the bot up. Deciding here keeps that precedence in one place, testable.
 *
 *   "beef"  - an aggro ping from somebody who is fair game
 *   "armed" - the answer to the opener we armed
 *   "skip"  - not ours: our own account, another account of ours, or a friend
 */
export function pickBeefRoute(opts = {}) {
  const aggro = Boolean(opts.aggro);
  const armed = Boolean(opts.armedAnswer);
  if (opts.isSelf) return "skip";
  if (opts.isHyper) return "skip";
  if (opts.whitelisted) return "skip";
  if (aggro) return "beef";
  if (armed) return "armed";
  return "skip";
}

/** heat: one number the beef path can scale off (severity x strikes x targeting x chain) */
export function heatOf(text, opts = {}) {
  const level = Math.max(0, Math.min(5, Number(opts.level) || 0));
  const strikes = Math.max(0, Math.min(20, Number(opts.strikes) || 0));
  const chain = Math.max(0, Math.min(10, Number(opts.chain) || 0));
  const target = opts.mentioned ? 1 : 0;
  void text;
  return Math.max(0, Math.min(100, Math.round(level * 12 + strikes * 6 + target * 10 + chain * 4)));
}

export function heatTier(heat) {
  const h = Number(heat) || 0;
  if (h <= 0) return "none";
  if (h < 25) return "light";
  if (h < 50) return "normal";
  if (h < 75) return "heavy";
  return "max";
}

/** >N distinct authors on us inside a window is a pile-on, not a chat */
export function mentionStorm(hits, opts = {}, config = DEFAULT_CONFIG) {
  const windowMs = Number(opts.windowMs) || Number(config.storm_window_ms) || 60000;
  const need = Number(opts.distinct) || Number(config.storm_distinct) || 3;
  const now = Number(opts.now) || Date.now();
  const recent = (hits || []).filter((h) => now - Number((h && h.ts) || 0) <= windowMs);
  const who = new Set(recent.map((h) => String((h && (h.authorId || h.id)) || "")).filter(Boolean));
  return { storm: who.size >= need, authors: who.size, hits: recent.length };
}

/* ---- the armed fight ----------------------------------------------------- */

// openers for an armed fight: the ping alone is not enough, it has to challenge
// them, and a fresh generated line can lead it when the generator offers one.
export const FIGHT_OPENERS = [
  "fight me",
  "square up",
  "1v1 me right now",
  "run it",
  "come outside",
  "say it to my face",
  "you and me, no excuses",
  "talk is cheap, fight me",
  "stop hiding and run it",
  "im waiting, fight me",
  "catch a fade",
  "quit typing and square up",
];

export function fightOpeners(opts = {}) {
  const extra = String(opts.extra || "").replace(new RegExp("\\s+", "g"), " ").trim().slice(0, 120);
  return extra ? [extra].concat(FIGHT_OPENERS) : FIGHT_OPENERS.slice();
}

/** the challenge itself, one line, no ping yet */
export function pickOpener(opts = {}) {
  const pool = fightOpeners(opts);
  const roll = Number.isFinite(Number(opts.roll)) ? Number(opts.roll) : Math.random();
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)));
  return pool[index];
}

/**
 * An armed "<@target> fight me": sending the opener is the trigger, the answer is
 * the beef. Expiry keeps a stale arm from firing hours later.
 */
export function armFight(targetId, opts = {}, config = DEFAULT_CONFIG) {
  const now = Number(opts.now) || Date.now();
  const armMs = Math.max(1000, Math.min(3600000, Number(opts.armMs) || Number(config.arm_ms) || 120000));
  return {
    id: String(targetId || ""),
    name: String(opts.name || ""),
    selfId: String(opts.selfId || ""),
    source: String(opts.source || "fight"),
    at: now,
    until: now + armMs,
    openers: (Array.isArray(opts.openers) ? opts.openers : []).map(String).slice(-5),
  };
}

/** does this message answer an armed opener? `msg` is `{ authorId, replyTo }` */
export function fightAnswer(arm, msg = {}, now = Date.now()) {
  if (!arm || !arm.id) return false;
  if (arm.until && now > Number(arm.until)) return false;
  const id = String(msg.authorId || "");
  if (!id || id === String(arm.selfId || "")) return false;
  if (id === String(arm.id)) return true;
  const replyTo = String(msg.replyTo || "");
  return Boolean(replyTo) && (arm.openers || []).includes(replyTo);
}

/* ---- the afk call -------------------------------------------------------- */

// a check we send: varied, and it sharpens the more times we have to ask
export const AFK_CHECK_LINES = [
  "you alive",
  "hello",
  "u there",
  "you went quiet",
  "anyone home",
  "wake up",
  "still with me",
  "you typing or sleeping",
  "afk check",
  "did you drop",
  "you got five seconds",
  "im not asking twice",
  "answer or im gone",
  "last chance before i log",
];

export function afkCheckLine(count, opts = {}) {
  const n = Math.max(1, Math.min(50, Number(count) || 1));
  const name = String(opts.name || "").trim().split(" ")[0];
  const who = name ? " " + name : "";
  if (n >= 6) return "#" + n + " and still no answer" + who + " - answer or im out";
  if (n >= 4) return "#" + n + " checks" + who + " - say something or i log off";
  if (n >= 2) return "#" + n + " - you ignoring me" + who;
  const roll = Number.isFinite(Number(opts.roll)) ? Number(opts.roll) : Math.random();
  const index = Math.min(AFK_CHECK_LINES.length - 1, Math.max(0, Math.floor(roll * AFK_CHECK_LINES.length)));
  return AFK_CHECK_LINES[index] + who;
}

// how long a run of checks stays alive: 4 checks in a minute is a person starting
// something, 4 checks spread over an hour is just somebody going afk a lot
export const CHECK_WINDOW_MS = DEFAULT_CONFIG.afk_check_window_ms;

export function afkCheckRun(prevCount, lastAt, now, opts = {}, config = DEFAULT_CONFIG) {
  const windowMs = Number(opts.windowMs) || Number(config.afk_check_window_ms) || CHECK_WINDOW_MS;
  const count = Number(prevCount) || 0;
  const last = Number(lastAt) || 0;
  if (!count || !last || now - last > windowMs) return 1;
  return count + 1;
}

// a check that lands seconds after the one we just answered is an echo of it,
// not a new question: answering every repeat is how a bot looks like a bot
export const AFK_QUIET_MS = DEFAULT_CONFIG.afk_quiet_ms;
// how many of their checks we answer before silence is the better answer
// (their count resets whenever they are not the run we are tracking)
export const AFK_ANSWER_MAX = DEFAULT_CONFIG.afk_answer_max;
// a name-drop this long after our own last word, with no ping and no reply, is
// somebody checking the room rather than checking us
export const AFK_STALE_THREAD_MS = DEFAULT_CONFIG.afk_stale_thread_ms;
// a run this long in the window stopped being a question a while ago
export const AFK_ESCALATE_AT = DEFAULT_CONFIG.afk_escalate_at;
// a run of checks this long where we only stayed quiet: past a point silence
// reads as broken rather than absent, so one answer breaks the streak
export const AFK_BREAK_SILENCE_AT = DEFAULT_CONFIG.afk_break_silence_at;
// checks landing closer together than this are somebody hammering the bot
// rather than somebody wondering where we went
export const AFK_CADENCE_FAST_MS = DEFAULT_CONFIG.afk_cadence_fast_ms;

function afkCall(answer, escalate, reason, extra = {}) {
  return {
    answer: Boolean(answer),
    escalate: Boolean(escalate),
    reason: String(reason),
    wpmScale: Math.max(0.5, Math.min(1.6, Number(extra.wpmScale) || 1)),
    waitMs: Math.max(0, Math.min(2000, Math.round(Number(extra.waitMs) || 0))),
  };
}

/**
 * Is this afk check the real thing, is it aimed at us at all, should we answer,
 * and how fast? One place for the call, so the reply path only sends and a test
 * can drive the same decision.
 *
 * Everything it reads is passed in - what the line did (tagged us, replied to
 * us, just named us), the run of checks, what we remember about the checker,
 * what the room has been saying to us, and how long ago we last spoke - so the
 * answer is the same in a test as it is in a live channel.
 *
 *   answer    - false means stay quiet for this one
 *   escalate  - true means this is bait and belongs in the beef path
 *   wpmScale  - how fast to type the answer (1 = their normal speed)
 *   waitMs    - a deliberate pause before answering (0 = straight away)
 */
export function afkDecision(opts = {}, config = DEFAULT_CONFIG) {
  const tagged = Boolean(opts.tagged);
  const replied = Boolean(opts.replied);
  const named = Boolean(opts.named);
  const aimed = tagged || replied || named;
  const count = Math.max(1, Math.floor(Number(opts.checkCount) || 1));
  const seen = Math.max(0, Math.floor(Number(opts.checksSeen) || 0));
  const answered = Math.max(0, Math.floor(Number(opts.answered) || 0));
  const quiet = Math.max(0, Math.floor(Number(opts.quieted) || 0));
  const turns = Math.max(0, Math.floor(Number(opts.theirTurns) || 0));
  const heat = Number(opts.heat) || 0;
  const escalateAt = Math.max(2, Math.floor(Number(opts.escalateAt) || Number(config.afk_escalate_at) || AFK_ESCALATE_AT));
  const breakAt = Math.max(2, Math.floor(Number(opts.breakSilenceAt) || Number(config.afk_break_silence_at) || AFK_BREAK_SILENCE_AT));
  const quietMs = Math.max(1000, Number(opts.quietMs) || Number(config.afk_quiet_ms) || AFK_QUIET_MS);
  const cadenceMs = Math.max(1000, Number(opts.cadenceMs) || Number(config.afk_cadence_fast_ms) || AFK_CADENCE_FAST_MS);
  const answerMax = Math.max(1, Math.floor(Number(opts.answerMax) || Number(config.afk_answer_max) || AFK_ANSWER_MAX));
  const sinceLast = Number(opts.sinceLastMs);
  const ourLast = opts.ourLastMs === null || opts.ourLastMs === undefined ? null : Number(opts.ourLastMs);
  const quietStreak = Math.max(0, Math.floor(Number(opts.quietStreak) || 0));
  const gapMs = Number(opts.gapMs);

  // nothing in the line is aimed at us: the room can sort that out itself
  if (!aimed) return afkCall(false, false, "not aimed at us");

  // a run of checks is not a question any more, it is somebody starting it
  if (count >= escalateAt) return afkCall(true, true, "check #" + count + " - bait, not a question");

  // seconds after our last answer to the same person is them repeating it
  if (answered >= 1 && Number.isFinite(sinceLast) && sinceLast <= quietMs) {
    return afkCall(false, false, "echo " + Math.round(sinceLast / 1000) + "s after the one we answered");
  }

  // we have stayed quiet a long run of times: past a point silence stops reading
  // as "not here" and starts reading as broken, so one answer breaks the streak
  if (quietStreak >= breakAt) {
    return afkCall(true, false, "broke a " + quietStreak + "-check silence", { wpmScale: 0.9 });
  }

  // we have answered them plenty with nothing new coming back: stop feeding it
  if (answered >= answerMax) return afkCall(false, false, "answered " + answered + " of " + seen + " already");

  // a bare name in a dead thread: they are checking the room, not us. Only
  // applies when we actually know when we last spoke
  if (!tagged && !replied && ourLast !== null && Number.isFinite(ourLast) && ourLast > AFK_STALE_THREAD_MS && !turns) {
    return afkCall(false, false, "named us " + Math.round(ourLast / 60000) + "m after our last word");
  }

  // it is a real check. Who is asking, and how fast do we come back
  let speed = 1;
  let waitMs = 0;
  let why = "a check aimed at us";
  if (tagged) {
    speed = 1.3;
    why = "tagged us - answer straight away";
  } else if (replied) {
    speed = 1.15;
    why = "a reply to our own message";
  } else {
    speed = 0.95;
    why = "named us without pinging";
  }
  if (turns >= 2) {
    speed += 0.15;
    why += ", mid-thread";
  }
  if (count >= 2) {
    speed *= 0.8;
    why += " (check #" + count + ")";
  }
  // their quirk: somebody who checks us constantly gets the slow, bored answer
  if (seen >= 5) {
    speed *= 0.7;
    waitMs = 600;
    why += " - serial checker";
  } else if (quiet >= 2) {
    speed *= 0.85;
    why += " - already ignored twice";
  }
  if (heat >= 50) {
    speed *= 0.9;
    why += " - running hot";
  }
  // their cadence: checks landing close together are somebody hammering the bot,
  // not somebody wondering where we went, so we come back slower
  if (Number.isFinite(gapMs) && gapMs > 0 && gapMs < cadenceMs) {
    speed *= 0.9;
    why += " - checks us every " + Math.max(1, Math.round(gapMs / 1000)) + "s";
  }
  return afkCall(true, false, why, { wpmScale: speed, waitMs });
}

// a mob is not a conversation: we answer it once, then stay out of it
export const MOB_WINDOW_MS = DEFAULT_CONFIG.mob_window_ms;

export function mobReplyMode(storm, lastMobAt, now, opts = {}, config = DEFAULT_CONFIG) {
  const windowMs = Number(opts.windowMs) || Number(config.mob_window_ms) || MOB_WINDOW_MS;
  if (storm && storm.storm) return { mode: "once", until: now + windowMs, fresh: true };
  const last = Number(lastMobAt) || 0;
  if (last && now - last < windowMs) return { mode: "quiet", until: last + windowMs, fresh: false };
  return { mode: "normal", until: 0, fresh: false };
}

// the same hands starting on us again inside the hour walks in escalated
export const STARTER_WINDOW_MS = DEFAULT_CONFIG.starter_window_ms;

export function starterBump(priorStarts, opts = {}) {
  const n = Math.max(0, Math.floor(Number(priorStarts) || 0));
  // an explicit zero is a real setting: it turns the bump off
  const step = opts.step === undefined ? 1 : Math.max(0, Number(opts.step) || 0);
  if (n >= 3) return step * 2;
  if (n >= 1) return step;
  return 0;
}

/** what we remember about somebody, in one line we can actually send */
export function recallLine(recall, name, opts = {}) {
  const who = String(name || "u").toLowerCase().slice(0, 24);
  const bits = [];
  const grudges = Math.max(0, Math.floor(Number(recall && recall.grudges) || 0));
  const joke = recall && recall.joke ? String(recall.joke).slice(0, 60) : "";
  const topic = recall && recall.topic ? String(recall.topic) : "";
  if (grudges >= 3) bits.push("thats " + grudges + " times now " + who + " and u still type like this");
  if (grudges >= 2) bits.push(who + " again? i remember how the last one went");
  if (joke) bits.push("still saying \"" + joke + "\"");
  if (topic) bits.push("back on the " + topic + " thing " + who + "? we been here");
  if (!bits.length) return "";
  const roll = Number.isFinite(Number(opts.roll)) ? Number(opts.roll) : Math.random();
  return bits[Math.min(bits.length - 1, Math.max(0, Math.floor(roll * bits.length)))];
}

/* ---- reactions, quotes, and the words that carry a line ------------------ */

// what we answer an emoji with: somebody drops one, we drop one back. The value
// is the reaction we add, so a few inputs fold into the same answer.
export const REACT_EMOJIS = {
  "💀": "💀", "☠️": "💀", "🔥": "🔥", "😂": "😂", "🤣": "😂", "😭": "😂",
  "🤡": "🤡", "🗿": "🗿", "💩": "💩", "🐀": "🐀", "👑": "👑", "🧢": "🧢",
  "🥱": "🥱", "😴": "🥱", "🐐": "🐐", "🎯": "🎯", "🪦": "🪦", "⚰️": "🪦",
  "🚮": "🚮", "🧠": "🧠", "🤓": "🤡", "😹": "😂", "🫡": "🫡",
  "🍿": "🍿", "👀": "👀", "😤": "😤", "🙄": "🥱", "😐": "🥱", "🥴": "🥱",
  "🤮": "💩", "🤢": "💩", "🫠": "💀", "😵": "💀", "🩸": "💀", "🔪": "💀",
  "🦴": "💀", "📉": "🪦", "📈": "🔥", "🧂": "🧢", "🤥": "🧢", "💅": "👑",
  "🙏": "🫡", "🤫": "🫡", "👎": "🗿", "🖕": "🗿", "🧊": "🗿", "🪑": "🪦",
};

/** the emoji worth reacting with to this message, or "" for none */
export function emojiReaction(text, opts = {}) {
  const raw = String(text || "");
  if (!raw) return "";
  const found = [];
  for (const [ch, out] of Object.entries(REACT_EMOJIS)) {
    if (raw.includes(ch) && !found.includes(out)) found.push(out);
  }
  if (!found.length) return "";
  const roll = Number.isFinite(Number(opts.roll)) ? Number(opts.roll) : Math.random();
  return found[Math.floor(roll * found.length) % found.length];
}

// a line does not have to carry an emoji to earn one: the classic L, a cope, a
// burn. Ordered so the sharpest reading of the line wins the tuple first.
export const REACT_CUES = [
  [/\bratio\b|\bratio'?d\b|\bgot ratioed\b/, "📉"],
  [/\btook (an|the) l\b|\b(taking|take) l\b|\bmega ?l\b|\bmonumental l\b|\bhard l\b|\bl \+ ratio\b/, "🪦"],
  [/\bwho let (him|her|them|this guy) cook\b|\bcooked\b|\bcooking\b/, "🔥"],
  [/\bcope\b|\bseethe\b|\bmalding\b|\bmald\b|\bcopium\b/, "😂"],
  [/\bclown\b|\bbozo\b|\bnpc\b|\bsmoothbrain\b|\bclownery\b/, "🤡"],
  [/\bmid\b|\bdogshit\b|\bgarbage\b|\bwashed\b|\bfinished\b/, "💀"],
  [/\bfarm(ing)? (the )?w\b|\bw farm\b/, "🐐"],
];

/** the emoji a text cue earns, or "" for none */
export function reactionCue(text, opts = {}) {
  const t = normalize(text);
  if (!t) return "";
  const hits = [];
  for (const [re, emoji] of REACT_CUES) {
    if (re.test(t) && !hits.includes(emoji)) hits.push(emoji);
  }
  if (!hits.length) return "";
  const roll = Number.isFinite(Number(opts.roll)) ? Number(opts.roll) : Math.random();
  return hits[Math.floor(roll * hits.length) % hits.length];
}

/**
 * The only lines worth quoting back are jokes and insults - a plain sentence is
 * noise. Returns "insult", "joke" or "" so the picker can be strict.
 */
export function quoteKind(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const t = normalize(raw);
  if (!t) return "";
  let aggro = { aggro: false, classes: [] };
  try {
    aggro = detectAggro(raw, { mentioned: true, repliedToUs: false, selfId: "0" });
  } catch {
    aggro = { aggro: false, classes: [] };
  }
  const insultClasses = ["nuclear", "threat", "insult", "mock", "dismiss"];
  if (aggro.aggro || (aggro.classes || []).some((c) => insultClasses.includes(c))) return "insult";
  if (INSULT_CUES.some((w) => cueHit(t, w))) return "insult";
  // a joke: a laugh marker with something to laugh at, or a setup/punchline shape
  const laugh = /(^|\s)(lol|lmao|lmfao|rofl|kek|kekw|hehe|haha|hah|jk)(\s|$)/.test(t);
  const content = contentWords(raw).length;
  if (laugh && content >= 1) return "joke";
  if (/\b(why did|what do you call|walks? into a bar|knock knock|how many .* to)\b/.test(t)) return "joke";
  // the shapes people actually joke in: "bro said ...", "im dead", a cook
  if (/(^|\s)(bro|man|dude|he|she|they) said(\s|$)/.test(t) && content >= 1) return "joke";
  if (/\b(im dead|im crying|im dying|deadass crying|lmao what|lmao who)\b/.test(t)) return "joke";
  if (/\bwho let (him|her|them|this guy) cook\b/.test(t)) return "joke";
  return "";
}

const NUMBERISH = /^[\d\s.,:%$+\-/()]+$/;
const LINKISH = /(https?:\/\/|www\.|\.com|\.gg|discord\.gg)/i;

/** worth quoting? a joke or an insult, not a number, a link or a bare mention */
export function quotableText(text, opts = {}) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (raw.length > 140) return false;
  if (raw.length < 8) return false;
  if (NUMBERISH.test(raw) || LINKISH.test(raw)) return false;
  if (/^[@#:)!?.&-]+$/.test(raw)) return false;
  const stripped = raw.replace(/<@!?\d+>/g, " ").replace(/<#\d+>/g, " ").trim();
  if (!stripped) return false;
  const parts = stripped.split(/\s+/);
  const words = parts.filter((w) => /[a-z]/i.test(w));
  if (words.length < 3) return false;
  // length is not the test: filler has to be judged on what it actually says
  const meaty = contentWords(stripped);
  if (meaty.length < 2) return false;
  const numeric = parts.filter((w) => /^\d[\d.,:%]*$/.test(w)).length;
  if (numeric / Math.max(1, parts.length) > 0.4) return false;
  if (opts.prefix && raw.startsWith(String(opts.prefix))) return false;
  // only jokes and insults are worth throwing back: a plain sentence is noise
  if (!quoteKind(raw)) return false;
  return true;
}

/**
 * One recent line that reads like a sentence, or null. `entries` are
 * `{ text, authorId, ts }`, which is the shape the client can build from its own
 * history without a Discord connection.
 */
export function pickQuote(entries, opts = {}) {
  const list = (entries || []).slice(-8);
  const used = (opts.used || []).map((t) => String(t));
  const good = list.filter((e) => {
    if (!e || !e.text) return false;
    if (opts.selfId && String(e.authorId) === String(opts.selfId)) return false;
    if (opts.avoidText && String(e.text) === String(opts.avoidText)) return false;
    if (used.includes(String(e.text))) return false;
    return quotableText(e.text);
  });
  if (!good.length) return null;
  // the operator's own vocabulary wins first (a line about what this server
  // actually talks about), then the lines that say the most, then random
  const vocab = new Set((Array.isArray(opts.words) ? opts.words : []).map((w) => String(w).toLowerCase()));
  const topical = (e) => (vocab.size ? contentWords(e.text).filter((w) => vocab.has(w)).length : 0);
  const ranked = good
    .slice()
    .sort((a, b) => topical(b) - topical(a) || contentWords(b.text).length - contentWords(a.text).length);
  const best = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
  const roll = Number.isFinite(Number(opts.roll)) ? Number(opts.roll) : Math.random();
  const pick = best[Math.min(best.length - 1, Math.max(0, Math.floor(roll * best.length)))];
  return { text: String(pick.text).slice(0, 140), authorId: String(pick.authorId || ""), ts: pick.ts || 0 };
}

export function quoteLine(entry) {
  if (!entry || !entry.text) return "";
  return '"' + entry.text + '"' + (entry.authorId ? " <@" + entry.authorId + ">" : "");
}

// filler carries no meaning: a quote has to be judged on what it says, not how long it is
const FILLER = new Set([
  "lol", "lmao", "lmfao", "rofl", "haha", "hahaha", "ok", "okay", "yeah", "yea", "yep", "yes",
  "no", "nah", "nope", "fr", "true", "same", "real", "bet", "fair", "sure", "cool", "nice", "gg",
  "ez", "w", "l", "bruh", "bro", "man", "dude", "guys", "yo", "sup", "hey", "hello", "hi", "idk",
  "idc", "ikr", "tbh", "ngl", "imo", "omg", "wtf", "wth", "meh", "eh", "hm", "hmm", "ig", "uh",
]);

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "i", "im", "you", "youre", "u", "ur",
  "he", "she", "they", "it", "we", "us", "me", "my", "your", "his", "her", "their", "them", "to",
  "of", "in", "on", "at", "for", "with", "is", "are", "was", "were", "be", "been", "being", "do",
  "does", "did", "dont", "cant", "wont", "not", "this", "that", "these", "those", "there", "here",
  "what", "why", "how", "when", "who", "which", "just", "like", "really", "very", "too", "also",
  "about", "from", "have", "has", "had", "will", "would", "could", "should", "get", "got", "go",
  "going", "know", "think", "want", "need", "some", "any", "all", "one", "two", "now", "still",
  "even", "only", "well", "back", "out", "up", "down", "off", "over", "again", "because", "cause",
  "though", "than", "them", "its", "as", "by", "no", "yes", "am", "are", "please", "would", "could",
]);

/** the words that actually carry the meaning of a line */
export function contentWords(text) {
  const raw = String(text || "").replace(/<@!?\d+>/g, " ").replace(/<#\d+>/g, " ");
  return raw
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !FILLER.has(w) && !STOPWORDS.has(w));
}

/** does the line read like a statement somebody meant? */
export function meaningfulText(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const words = raw.replace(/<@!?\d+>/g, " ").split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length < 3) return false;
  return contentWords(raw).length >= 2;
}
