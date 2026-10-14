// language: JavaScript, file: src/beef-lines.js
//
// The lines: the client's own copy of the banter, AFK and joke banks the account's
// beef path draws its filler from, ported from the control server's own content module
// (hyper/hyper/content.py) so that every one of the beef functions works with no server
// configured. It is a pure module on purpose - no imports, no filesystem, no timers, no
// network - because the same file has to run inside Electron's main process, inside the
// vendored renderer bundle, and under `node tests/...` with nothing stood up for it.
//
// Three rules hold it together:
//
//   * **the banks are copied, not invented.** Every array below is the server's own
//     list, verbatim, in its own order: the client must never be the reason the account
//     says something its operator did not put in the banks.
//   * **a draw is a draw.** Every function that picks takes an optional `rng` - a
//     function returning 0..1 - defaulting to Math.random, and the picks go through
//     `chooser()`, so a test can hand in a deterministic sequence and reproduce any
//     line exactly. The port is otherwise the server's logic, including its order of
//     preference (a topic's own bank before the general one, and never a repeat).
//   * **the two halves stay apart.** Composing a reply from an intent and a topic
//     (composeReply) is a different job from picking a line, and a caller that wants a
//     labelled line calls the bank it means.
export const SECONDARY_MESSAGES = [
  "whered u go",
  "he ran",
  "hello?",
  "where the fuck did u go",
  "is anyone there?",
  "wtf son come back",
  "yo u ghosted?",
  "get back here pussy",
  "speak up bitch",
  "u ran like a bitch",
  "come back and take this L",
  "dont hide now pussy",
  "u scared already?",
  "run again i dare u",
  "u still here or what",
  "speak up dork",
  "still there?",
  "taking a break?",
  "no rush \u2014 checking in",
];

export const QUIT_MESSAGES = [
  "oh ai what i thought",
  "guess they left",
  "shut the fuck up dont step to me again",
  "next lowtier step up and die faggot",
  "my bitch ran from me",
  "u tremble in my presence loser u died",
  "ran like a bitch",
  "gg coward",
  "fold and leave then",
  "gg soft ass nigga",
  "u died mid sentence",
  "get offline pussy",
  "u left like a bitch with no spine",
  "another one folds",
  "kys offline retard",
  "gg",
  "next lowtier step up and die",
  "gg you left first",
  "ran like always",
  "looks like you're away; i'll pause here",
  "we can pick this up later",
];

export const WELCOME_BACK = [
  "oh ai den lock tf in pussy",
  "shitty dork dont run yet",
  "we can go all day i wont stop?",
  "on god you wont bitch me?",
  "on god ur ass as fuck my nigga?",
  "back already? sit down",
  "welcome back bitch lock in",
  "u came back for more L?",
  "missed me? sit the fuck down",
  "back for another beating?",
  "back",
  "on god ur ass as fuck",
  "back already? keep up",
  "welcome back \u2014 where were we?",
  "there you are. all good",
  "back from the side quest?",
];

export const FINAL_MESSAGES = [
  "gg retard",
  "gg faggot",
  "ill take my victory slut",
  "u fucking bored me to death loser",
  "get off my dick",
  "bye bitch",
  "session over u folded",
  "eat that L and log",
  "u got owned shut the fuck up",
  "go touch grass and cry",
  "bye",
  "session closed you folded",
  "catch you later",
  "pausing the bit \u2014 see you around",
];

export const CONFUSED_REPLIES = [
  "huh?",
  "what?",
  "i don't know that command",
  "??",
  "not a command",
  "try again",
  "invalid",
  "what do you mean",
  "?",
  "not sure what you meant \u2014 try help",
  "that isn't a command",
  "try help for the list",
];

export const BANTER_REPLIES = [
  "shut the fuck up ur a weak bitch",
  "ur a pathetic loser talking shit",
  "get fucked ur nothing",
  "stfu ur a degenerate faggot",
  "ur a lowtier dork with no grip",
  "talk quieter before i cook u",
  "u type like u lost already",
  "that was a weak ass comeback nigga",
  "ur whole bloodline is soft",
  "fold quieter next time",
  "u got no bite just noise",
  "keep yapping i own this chat",
  "ur the reason this server is trash",
  "sit down before u embarrass yourself more",
  "u sound mad for someone losing",
  "go touch grass then come back weaker",
  "that insult missed like ur aim",
  "u're a walking L",
  "cry about it somewhere else",
  "stfu retard nobody asked",
  "ur a broke ass bitch with loud fingers",
  "shut up before i make u my bitch",
  "u talk tough for a bottom tier faggot",
  "sit the fuck down soft nigga",
  "ur mom shouldve swallowed",
  "go cry to somebody who cares pussy",
  "u got the energy of a participation award",
  "keep coping loser",
  "ur life is a skill issue",
  "dumbass really thought that landed",
  "shut ur cunt and watch",
  "u're a mid bitch with mid takes",
  "log off before u dig a deeper grave",
  "that mouth writes checks ur hands bounce",
  "i'll fucking bury u in this chat",
  "ur ancestors are embarrassed",
  "speak when spoken to bitch",
  "u got dog in u? no just mutt",
  "one more word and i own ur whole bloodline",
  "u type like u got lead poisoning",
  "shut the fuck up and take notes",
  "ur a walking abortion with wifi",
  "go off yourself verbally first",
  "i eat niggas like u for warmups",
  "u got no soul just cope",
  "kneel before this chat faggot",
  "ur confidence is a hate crime against reality",
  "i'll make u my personal L farm",
  "stfu",
  "SHUT THE FUCK UP UR A WEAK BITCH",
  "UR A WEAK DEGENERATE",
  "GET FUCKED UR NOTHING",
  "UR A LOSER",
  "STFU UR A PATHETIC FUCK",
  "bold words from a soft target",
  "that take died on arrival",
  "you type loud and hit nothing",
  "your comeback arrived late and empty",
  "even your typo is embarrassed for you",
  "talk slower \u2014 you're losing the exchange",
  "that insult had a running start and still missed",
  "you're not wrong, you're just loud and wrong",
  "your argument needs less volume",
  "i've seen better takes in a loading screen",
  "bold words for a message with no patch notes",
  "that take needs another draft",
  "i'll file that under creative feedback",
  "the confidence is impressive. the evidence is loading",
  "we can disagree without turning caps lock into a personality",
  "fair enough \u2014 let's keep it playful",
  "that's a hell of a take. got anything behind it?",
  "damn, the confidence arrived before the explanation",
  "that argument needs less volume and a better second draft",
  "you type like the argument is winning without you",
  "that was a lot of confidence for someone losing the exchange",
  "you brought a feeling to a fact fight",
  "your comeback arrived late and underdressed",
  "i've read better takes on the back of a cereal box",
  "you're the reason instructions have pictures",
  "talk slower \u2014 you're losing me and the argument",
  "you're not wrong, you're just loud and adjacent to wrong",
];

export const TOPIC_BANTER = {
  gaming: [
    "u play like the tutorial carried u",
    "ur aim and ur ego both trash",
    "participation award gaming",
    "lots of talk for a 0.3 kd dog",
    "teammates mute u for a reason",
    "u feed harder than the bots",
    "rank inflated by luck not skill",
    "gg soft aim bitch",
    "u die more than the bots on easy",
    "controller player energy and still mid",
    "u're the reason your team throws",
    "uninstall and apologize to the lobby",
    "0 kd and a manifesto",
    "u aim with ur feet retard",
    "even the bots feel bad for u",
    "gg soft",
    "you play like the tutorial was optional",
    "your aim and your argument both missed",
    "that was a participation award, not a win",
    "lots of talk for someone with a losing record",
    "you're the teammate everyone mutes",
    "gg no re soft aim",
    "you're the teammate everyone mutes and nobody misses",
  ],
  tech: [
    "ur code and ur takes both crash",
    "hello world would fail review on u",
    "that take doesnt even compile",
    "u're an unhandled exception with legs",
    "ur hotfix is the outage",
    "stack overflow of Ls",
    "ur brain threw null",
    "segfault between the ears",
    "ur logic is a memory leak",
    "delete system32 of ur personality",
    "your code and your opinion have the same bug",
    "you would fail review on a hello-world",
    "that take has no tests and it doesn't compile",
    "you're the human equivalent of an unhandled exception",
    "your hotfix is the reason the incident exists",
    "you would fail review in a hello-world repo",
  ],
  food: [
    "ur argument is burnt and undercooked",
    "season ur takes next time retard",
    "half baked and still mid",
    "recipe for a loss",
    "couldnt cook a point if u tried",
    "ur takes taste like mid",
    "serve that L with a side of shut the fuck up",
    "ur brain is undercooked spam",
    "your argument is undercooked",
    "you season opinions blindly",
    "that take is half-baked",
    "your recipe for a win is missing the win",
    "your argument is undercooked and somehow still burnt",
    "you season opinions the way you season food \u2014 blindly",
    "that take is half-baked and not the good kind",
    "you couldn't cook that point past medium",
  ],
  night: [
    "go to sleep ur brain is offline",
    "late night and still this stupid",
    "moon tired of ur opinions too",
    "last brain cell clocked out",
    "log off before u dig deeper",
    "midnight and still a dumbass",
    "the night is young u already lost",
    "sleep or keep taking these Ls",
    "go to sleep \u2014 your argument needs the rest",
    "it's late and your take is later",
    "even the moon is tired of that opinion",
    "your last brain cell is filing a complaint",
    "go to sleep \u2014 your argument needs the rest more than you do",
    "it's late and your take is even later",
    "you asked your brain for sleep and handed it this instead",
  ],
};

export const JOKE_TOPICS = {
  general: [
    "ur presence is a participation trophy",
    "i came prepared u came mid",
    "group chat lore and ur still the side character",
    "backup plan is owning u",
    "train of thought left without u",
    "spreadsheet of ls with ur name on it",
    "overthinking? u underthinking",
    "loading screen has more personality",
    "vibes immaculate instructions missing for u",
    "mysterious by being irrelevant",
    "more lore than ur win history",
    "backup plan for when u fold",
    "receipts are just ur losses",
    "scenic route to being wrong",
    "bonus commentary on ur failure",
    "clever reply failed dress rehearsal like u",
    "confidence and competence on different shifts for u",
    "u type like the server owes u something",
    "lock in or log off bitch",
    "soft target detected",
    "say something that hits for once",
    "volume high substance zero faggot",
    "u folded before the real part started",
    "mid take mid delivery mid life",
    "u brought a feeling to a fact fight and lost both",
    "session still open u still losing",
    "i own this chat u rent space in it",
    "ur whole personality is a skill issue",
    "stfu and take the l like a man",
    "ur bloodline is a participation event",
    "dumbass energy radiating off that message",
    "go be someone else's problem pussy",
    "i'll make this chat ur graveyard",
    "u got the aura of a failed abortion",
    "speak less exist less",
    "ur takes are a war crime",
    "i run this bitch u just visit",
    "kneel or leave faggot",
    "ur ego is unpaid labor",
    "i'll cook u til the server burns",
    "u are the reason god left",
    "another day another victim",
    "i dont debate i execute",
    "ur whole life is a loading screen of ls",
    "l",
    "lock in or log off",
    "you talk like you got backup",
    "say something that hits",
    "this the best you got?",
    "volume high, substance zero",
    "you folded before the real part started",
    "keep typing i need the entertainment",
    "mid take mid delivery",
    "you brought a feeling to a fact fight",
    "session still open you still losing",
    "i came prepared you came loud",
    "that plot twist had no budget",
    "group chat experimental phase and you the test subject",
    "backup plan is snacks and better opponents",
    "train of thought derailed on contact",
    "i'm not overthinking i'm adding side quests",
    "that sounded better in the loading screen",
    "vibes immaculate instructions missing",
    "mysterious by forgetting what i was saying",
    "more lore than your save file",
    "receipts mostly for snacks",
    "argument took the scenic route",
    "bonus commentary part of the chat",
    "clever reply failed dress rehearsal",
    "confidence and competence on different shifts",
    "my attention span has opened another tab",
    "i came prepared. unfortunately, for a different conversation",
    "that plot twist was on a very reasonable budget",
    "the group chat has entered its experimental phase",
    "i have a backup plan. it's mostly snacks",
    "my train of thought is currently a replacement bus",
    "somewhere, a spreadsheet is taking this personally",
    "i'm not overthinking. i'm adding optional side quests",
    "the vibes are immaculate. the instructions are missing",
    "i've decided to be mysterious by forgetting what i was saying",
    "this conversation has more lore than my save file",
    "my backup plan has asked for a backup plan",
    "i brought receipts. they're mostly for snacks",
    "that argument took the scenic route to the point",
    "we've reached the bonus commentary part of the chat",
    "i had a clever reply, but it failed the dress rehearsal",
    "my confidence and my competence are on different shifts",
  ],
  gaming: [
    "aim is a community art project and u failed",
    "not lost just griefing the bit",
    "boss fight was fine until u queued",
    "limited edition strategy called feeding",
    "best move saved for a replay nobody watches",
    "inventory full of cope",
    "tutorial said dodge u heard die",
    "hard mode: existing near u",
    "crosshair sightseeing while u miss",
    "respawn screen is ur home screen",
    "boss fight confidence tutorial skill",
    "clutch held by panic and a loud keyboard",
    "strategy has lore zero results",
    "map declined responsibility for u",
    "u play like ping is a personality",
    "0.2 kd and a god complex",
    "u feed so hard the enemy teams tip u",
    "rank check first then talk bitch",
    "gg soft no re",
    "controller drift is ur only excuse left",
    "u die so much the game thinks u're afk farming",
    "uninstall before ur teammates do",
    "ur kda is a hate crime",
    "even the practice bots carried u",
    "u aim like u got parkinsons in ur fingers",
    "aim is a community art project",
    "wasn't lost was doing environmental storytelling",
    "boss fight fine until the boss got involved",
    "not a misplay limited-edition strategy",
    "saved the best move for the replay nobody recorded",
    "inventory ninety percent might-need-later",
    "tutorial said dodge i heard improvise",
    "hard mode: distracted",
    "crosshair sightseeing again",
    "respawn screen and i on first-name terms",
    "boss-fight confidence tutorial decisions",
    "strategy excellent lore questionable results",
    "checked the map map declined responsibility",
    "rank check you first",
    "gg soft",
    "my aim is a community art project",
    "i wasn't lost. i was doing environmental storytelling",
    "the boss fight was going well until the boss got involved",
    "that wasn't a misplay; it was a limited-edition strategy",
    "i saved the best move for the replay nobody recorded",
    "my inventory is ninety percent things i might need later",
    "the tutorial said dodge. i heard improvise",
    "i'm playing on hard mode: distracted",
    "my crosshair is sightseeing again",
    "the respawn screen and i are on first-name terms",
    "i brought boss-fight confidence to tutorial-level decisions",
    "that clutch was held together by panic and a very loud keyboard",
    "my strategy has excellent lore and questionable results",
    "i checked the map. the map declined responsibility",
  ],
  tech: [
    "works on my machine ur machine is trash",
    "code has a rich inner life zero docs like ur brain",
    "bug has a schedule u dont",
    "fixed one warning unlocked three ls",
    "computer asked for a restart same as this chat",
    "loading bar trusts u less than i do",
    "solution was one character finding it was ur life",
    "browser tabs are ur only friends",
    "fix worked until u touched it",
    "error message is a recurring character named u",
    "restarted it problem still has ur face",
    "debugging is asking the code why u exist",
    "server is fine definition of fine excludes u",
    "one more quick fix and this is archaeology",
    "segfault in the personality",
    "ur takes throw unhandled exceptions",
    "ur brain is legacy code nobody maintains",
    "npm install a personality retard",
    "ur logic has more holes than swiss cheese",
    "works on my machine my machine is forgiving",
    "code has a rich inner life no documentation",
    "bug isn't random it has a schedule",
    "fixed one warning unlocked three side quests",
    "computer asked for a restart honestly same",
    "loading bar and i have trust issues",
    "solution was one character finding it was a trilogy",
    "browser tabs are distributed memory",
    "fix worked until i tried using it",
    "error message is a recurring character",
    "restarted it problem has a fresh attitude",
    "debugging is asking the code what its problem is",
    "server is fine definition of fine under review",
    "one more quick fix becomes archaeology",
    "it works on my machine. my machine is very forgiving",
    "my code has a rich inner life and no documentation",
    "the bug isn't random. it has a schedule i don't understand",
    "i fixed one warning and unlocked three side quests",
    "my computer asked for a restart. honestly, same",
    "the loading bar and i have trust issues",
    "the solution was one character. finding it was a trilogy",
    "my browser tabs are a distributed memory system",
    "the fix worked until i tried using it",
    "the error message has become a recurring character",
    "i restarted it. now the problem has a fresh attitude",
    "my debugging technique is asking the code what its problem is",
    "the server is fine. the definition of fine is under review",
    "one more quick fix and this becomes an archaeological site",
  ],
  food: [
    "one snack away from a better opinion than urs",
    "cooking style is optimistic timer management",
    "recipe said serves four underestimated the l",
    "coffee is a loading screen with a smell",
    "meal prepped by knowing where the cope is",
    "kitchen timer is a suggestion engine for u",
    "shopping list has a strong mid lobby",
    "sandwich deserves better than ur take",
    "coffee promoted to project manager of this roast",
    "ordered a small snack got a new personality still mid",
    "recipe and i have creative differences like u and skill",
    "not procrastinating the kettle is holding a meeting",
    "dinner plans are patch notes for being hungry",
    "fridge light has seen worse late night decisions than ur takes",
    "ur argument is undercooked and somehow burnt",
    "serve that l cold bitch",
    "ur brain is expired milk",
    "one snack away from a revised opinion",
    "recipe said serves four underestimated me",
    "meal-prepped by knowing where the snacks are",
    "kitchen timer is a suggestion engine",
    "shopping list has a biscuit lobby",
    "sandwich deserves a better photograph",
    "coffee promoted to project manager",
    "ordered a small snack received a new personality",
    "recipe and i have creative differences",
    "dinner plans are patch notes for hungry",
    "fridge light has seen worse late-night decisions",
    "i'm one snack away from a fully revised opinion",
    "my cooking style is optimistic timer management",
    "the recipe said serves four. it underestimated me",
    "coffee is just a loading screen with a smell",
    "i meal-prepped by knowing where the snacks are",
    "the kitchen timer has become a suggestion engine",
    "my shopping list has a very strong biscuit lobby",
    "that sandwich deserves a better photograph than i can provide",
    "my coffee has been promoted to project manager",
    "i ordered a small snack and received a new personality",
    "the recipe and i have creative differences",
    "i'm not procrastinating. the kettle is holding a meeting",
    "dinner plans are just patch notes for being hungry",
    "the fridge light has seen my worst late-night decisions",
  ],
  night: [
    "sleep schedule is an abstract concept like ur wins",
    "moon and i avoiding a reasonable bedtime",
    "midnight is when the brain releases bonus ls",
    "not nocturnal daylight just has a scheduling conflict",
    "room is dark group chat lore is darker",
    "alarm clock is tomorrow's problem",
    "stars are out so is ur common sense",
    "planned an early night plan did not survive contact",
    "bedtime is an optional objective u failed",
    "late enough that tomorrow feels like a rumor",
    "moon gets a phase so does ur skill issue",
    "midnight overthinking expansion pack",
    "last brain cell requesting dark mode",
    "said one more message that was three plot twists ago",
    "log off retard the sun is coming",
    "night shift for taking ls",
    "sleep before i put u to sleep in this chat",
    "sleep schedule is an abstract concept",
    "midnight is when the brain releases bonus content",
    "not nocturnal daylight has a scheduling conflict",
    "room dark group chat lore darker",
    "stars are out so is common sense",
    "planned early night plan did not survive contact",
    "bedtime is an optional objective",
    "late enough tomorrow feels like a rumor",
    "moon gets a phase so does the sleep schedule",
    "my sleep schedule is an abstract concept",
    "the moon and i are both avoiding a reasonable bedtime",
    "midnight is when my brain starts releasing bonus content",
    "i'm not nocturnal. daylight just has a scheduling conflict",
    "the room is dark; the group chat lore is darker",
    "my alarm clock is tomorrow's problem",
    "the stars are out and so is my common sense",
    "i planned an early night. the plan did not survive contact",
    "my bedtime has become an optional objective",
    "it's late enough that tomorrow feels like a rumor",
    "the moon gets a phase. apparently so does my sleep schedule",
    "i'm in my midnight overthinking expansion pack",
    "my last brain cell is requesting dark mode",
    "i said one more message. that was three plot twists ago",
  ],
};

export const TOPIC_WORDS = {
  gaming: new Set(["game", "gaming", "aim", "boss", "quest", "rank", "ranked", "match", "win", "lose", "gg"]),
  tech: new Set(["code", "coding", "bug", "python", "computer", "pc", "lag", "wifi", "server", "crash"]),
  food: new Set(["food", "eat", "hungry", "snack", "coffee", "pizza", "cook", "dinner", "lunch"]),
  night: new Set(["night", "sleep", "tired", "midnight", "moon", "bed", "dark"]),
};

/** The server's own afk-check regex, kept as one source string so both uses share it. */
const CHECK_PATTERN =
  "\\b(?:afk\\s*[-_]?\\s*check|client\\s*[-_]?\\s*check|presence\\s*check|" +
  "(?:are\\s+)?(?:you|u)\\s+(?:afk|there|alive|awake|still\\s+here)|" +
  "anyone\\s+(?:there|home)|still\\s+there|roll\\s*call)\\b";
const CHECK_RE = new RegExp(CHECK_PATTERN, "i");
const WAKE_RE = /^wake\s+up[!?\s]*$/i;

export const CONVERSATION_REPLIES = {
  greeting: ["hey \u2014 what's up?", "yo. what's the topic?", "hey, i'm listening"],
  question: ["which part do you mean?", "give me a bit more context", "what have you tried so far?"],
  agreement: ["fair", "yeah, that tracks", "okay, we're on the same page"],
  laugh: ["okay, that one landed", "i'll take that as a win", "the bit survives another round"],
  pause: ["all good \u2014 i'll pause here", "take your time", "no rush. catch you later"],
  thanks: ["anytime", "got you \u2014 glad it helped", "no problem at all"],
  apology: ["you're fine \u2014 no harm done", "all good, that one's on the house", "don't sweat it"],
  confused: ["no worries \u2014 which part lost you?", "fair. want me to rephrase?", "let's back up: what's the unclear bit?"],
};

export const TOPIC_QUESTIONS = {
  gaming: ["about the game \u2014 which bit is giving you trouble?", "same match or a new one? what changed?", "is it the strategy, or is the game acting up?"],
  tech: ["about that issue \u2014 what error are you getting?", "does it happen every time, or only after a particular step?", "what changed before it started failing?"],
  food: ["still talking food? what are your options?", "are we choosing dinner, or reviewing the damage?", "what have you got to work with?"],
  night: ["still up? are you tired or just not ready to call it a night?", "is this a sleep question or a midnight thought?", "want to keep talking, or call it a night?"],
};

export const TOPIC_FRUSTRATION = {
  gaming: ["rough match. what keeps going wrong?", "damn. mechanics, teammates, or connection?"],
  tech: ["that's annoying. what's the exact error?", "let's narrow it down \u2014 what step breaks?"],
  food: ["kitchen plot twist? what went wrong?"],
  night: ["rough night? want to talk or take a breather?"],
  general: ["sounds frustrating. what happened?", "damn. what's the part that's bothering you?"],
};

// A coherent line is two halves: an opener that answers the intent, then a clause that
// continues the topic the channel is actually on. One fragment picked at random reads as
// noise, so a known intent plus a known topic is composed instead.
export const COHERENT_OPENERS = {
  greeting: ["hey", "yo", "sup"],
  agreement: ["fair", "true", "yeah, that tracks"],
  thanks: ["anytime", "got you", "no problem"],
  apology: ["you're fine", "all good", "no worries"],
  confused: ["fair enough", "my bad", "okay, let's back up"],
  laugh: ["okay, that landed", "ha", "good one"],
  frustration: ["that's rough", "damn", "yeah, that's annoying"],
};

export const TOPIC_FOLLOWUPS = {
  gaming: ["that match sounds like it had it out for you", "commit to one plan and the next round goes differently", "the aim is fine, the tilt is the problem"],
  tech: ["paste the exact error and i'll read it with you", "check what changed right before it broke", "half of those are one stale dependency wearing a costume"],
  food: ["pick the option you'd still want cold", "a snack is not a meal, but it is a start", "salt fixes more of that than anything else will"],
  night: ["sleep on it and look again in the morning", "late-night you is not a reliable narrator", "the call can wait until the sun is up"],
};

// Aggro detection: words that are always a fight, plus phrases that only are when they are
// aimed at the bot. Directed means a mention or a reply to us - the caller decides that,
// so the same detector serves both.
export const AGGRO_WORDS = new Set([
  "bitch", "shit", "fuck", "faggot", "retard", "idiot", "stupid", "loser",
  "clown", "cope", "seethe", "malding", "ratio", "trash", "garbage", "bot",
  "dumbass", "moron", "pathetic", "weak", "dog", "kid", "nobody", "cry",
]);

export const AGGRO_PHRASES = [
  "shut up", "shut the fuck up", "stfu", "gtfo", "kys", "who asked",
  "nobody asked", "nobody cares", "no one asked", "you're trash", "ur trash",
  "sit down", "log off", "uninstall", "bad bot", "dumb bot", "stupid bot",
  "l take", "take the l", "you lost", "skill issue", "all you do is",
];

const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const AGGRO_RE = new RegExp([...AGGRO_PHRASES].sort((a, b) => b.length - a.length).map(escapeRe).join("|"), "i");
const AGGRO_WORD_RE = new RegExp("\\b(?:" + [...AGGRO_WORDS].sort().map(escapeRe).join("|") + ")\\b", "i");

/* ---- the draws, on a caller-supplied rng --------------------------------- */

/**
 * Every pick in this file goes through one of these, so a single `rng` decides the whole
 * line and a test can reproduce it by handing in a fixed sequence. `chooser()` takes the
 * 0..1 function and returns the three draws the server's banks use: choice, shuffle and
 * sample. `Math.random` is the default, which is what a live client uses.
 */
export function chooser(rng) {
  const next = typeof rng === "function" ? rng : Math.random;
  const index = (length) => {
    if (length <= 0) return 0;
    const raw = Number(next());
    const value = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999) : 0;
    return Math.floor(value * length);
  };
  const choice = (seq) => (seq && seq.length ? seq[index(seq.length)] : "");
  const shuffle = (seq) => {
    const out = [...(seq || [])];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = index(i + 1);
      const swap = out[i];
      out[i] = out[j];
      out[j] = swap;
    }
    return out;
  };
  const sample = (seq, count) => shuffle(seq).slice(0, Math.max(0, Math.min(Number(count) || 0, (seq || []).length)));
  return { next, index, choice, shuffle, sample };
}

/* ---- the text cleaning every detector starts with ------------------------ */

/** Fenced and inline code removed, and quoted lines dropped, before anything reads it. */
export function unquotedText(text) {
  const plain = String(text === undefined || text === null ? "" : text).replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)/g, "");
  return plain
    .split(/\r?\n/)
    .filter((line) => !line.replace(/^\s+/, "").startsWith(">"))
    .join(" ");
}

/** Normalize live text, ignoring examples, links and mention markup. */
export function plainChatText(text) {
  const plain = unquotedText(text)
    .normalize("NFKC")
    .replace(/https?:\/\/\S+|<[@#][^>]+>|@everyone|@here/gi, "");
  return plain.replace(/\u2019/g, "'").trim();
}

/* ---- topics and intents --------------------------------------------------- */

/** The topic a line is on, by the topic words it says: the first bank wins a tie. */
export function topicFor(text) {
  const words = new Set(String(text || "").toLowerCase().match(/[a-z]+/g) || []);
  let best = "general";
  let bestScore = 0;
  for (const [topic, keywords] of Object.entries(TOPIC_WORDS)) {
    let score = 0;
    for (const word of words) if (keywords.has(word)) score += 1;
    if (score > bestScore) {
      best = topic;
      bestScore = score;
    }
  }
  return bestScore ? best : "general";
}

/** Newest explicit topic wins; short follow-ups inherit the recent topic. */
export function contextTopic(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (const message of list.slice(-12).reverse()) {
    const topic = topicFor(plainChatText(message));
    if (topic !== "general") return topic;
  }
  return "general";
}

/** Does the line say one of these keywords, as whole words, in any spacing? */
export function matchesTrigger(text, keywords) {
  const plain = plainChatText(text);
  for (const keyword of Array.isArray(keywords) ? keywords : []) {
    const parts = String(keyword || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const pattern = new RegExp("(?<!\\w)" + parts.map(escapeRe).join("\\s+") + "(?!\\w)", "i");
    if (pattern.test(plain)) return true;
  }
  return false;
}

/** What a line means, when it means something: greeting, question, pause, ... */
export function conversationIntent(text) {
  const plain = plainChatText(text).toLowerCase();
  if (/\b(?:brb|be right back|gotta go|gtg|going to sleep|goodnight)\b/.test(plain)) return "pause";
  if (/^(?:hey|hi|hello|yo|sup)[!.?\s]*$/.test(plain)) return "greeting";
  if (/\b(?:lol|lmao|haha|hahaha)\b/.test(plain)) return "laugh";
  if (/^(?:fair|agreed|true|exactly|yeah|yep|same|same here|this|fr|facts|real|word)[!.\s]*$/.test(plain)) return "agreement";
  if (/\b(?:thanks|thank you|thx|ty|cheers|appreciate it)\b/.test(plain)) return "thanks";
  if (/\b(?:my bad|sorry|apologies|my fault)\b/.test(plain)) return "apology";
  if (/^(?:what|huh|eh)\??$/.test(plain) || /\b(?:confused|don't get it|dont get it|no idea|idk|lost me|makes no sense)\b/.test(plain)) return "confused";
  if (/\b(?:broken|crashed|crashing|frustrated|not working|keeps failing)\b/.test(plain)) return "frustration";
  if (plain.includes("?")) return "question";
  return "";
}

/** Is this a fight, whatever it is aimed at? */
export function isAggro(text) {
  const plain = plainChatText(text).toLowerCase();
  return AGGRO_RE.test(plain) || AGGRO_WORD_RE.test(plain);
}

/** Is somebody asking whether we are still there? */
export function isAfkCheck(text) {
  const plain = plainChatText(text);
  return CHECK_RE.test(plain) || WAKE_RE.test(plain);
}

/** Does the raw line mention this user id, in Discord's own mention markup? */
export function mentionsUser(text, uid) {
  return new RegExp("<@!?" + String(uid) + ">").test(unquotedText(text));
}

/** A line stripped of markup, urls and formatting: what a joke is, as plain text. */
export function cleanJoke(raw) {
  return String(raw || "")
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>|@everyone|@here/gi, "")
    .replace(/#/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_~|`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---- the two-part reply -------------------------------------------------- */

/**
 * A coherent two-part line for a known intent and topic, else "". Both halves already
 * sent - and their halves on their own - are blocked, so the opener and the follow-up
 * rotate instead of repeating.
 */
export function composeReply(intent, topic, { previous = "", recentReplies = [], rng } = {}) {
  const pick = chooser(rng);
  const openers = COHERENT_OPENERS[String(intent)] || [];
  const followups = TOPIC_FOLLOWUPS[String(topic)] || [];
  if (!openers.length || !followups.length) return "";
  const blocked = new Set([String(previous || ""), ...(Array.isArray(recentReplies) ? recentReplies : []).map(String)]);
  for (const line of [...blocked]) for (const part of line.split(" \u2014 ")) blocked.add(part);
  const freshOpeners = openers.filter((line) => !blocked.has(line));
  const freshFollowups = followups.filter((line) => !blocked.has(line));
  if (!freshOpeners.length && !freshFollowups.length) return "";
  return pick.choice(freshOpeners.length ? freshOpeners : openers) + " \u2014 " + pick.choice(freshFollowups.length ? freshFollowups : followups);
}

/**
 * ``count`` different comebacks, the best-fitting topic first, never repeated. A small
 * bank still bursts: it is topped up with the lines the block filter rejected rather than
 * sending fewer than asked for.
 */
export function insultBurst({ count = 5, previous = "", context = [], recentReplies = [], rng } = {}) {
  const pick = chooser(rng);
  const wanted = Math.max(0, Math.floor(Number(count) || 0));
  const topic = contextTopic(context);
  const blocked = new Set([String(previous || ""), ...(Array.isArray(recentReplies) ? recentReplies : []).map(String)]);
  const ordered = [];
  for (const pool of [TOPIC_BANTER[topic] || [], BANTER_REPLIES]) {
    for (const line of pick.shuffle(pool)) {
      if (line && !blocked.has(line) && !ordered.includes(line)) ordered.push(line);
    }
  }
  if (!ordered.length) return [];
  if (ordered.length >= wanted) return ordered.slice(0, wanted);
  const extras = [...BANTER_REPLIES, ...(TOPIC_BANTER[topic] || [])].filter((line) => line && !ordered.includes(line));
  ordered.push(...pick.shuffle(extras).slice(0, wanted - ordered.length));
  return ordered.slice(0, wanted);
}

/** One themed comeback, never the one just sent. */
export function banterReply({ previous = "", context = [], rng } = {}) {
  const pick = chooser(rng);
  const topic = contextTopic(context);
  const themed = (TOPIC_BANTER[topic] || []).filter((line) => line !== previous);
  const general = BANTER_REPLIES.filter((line) => line !== previous);
  return pick.choice(themed.length ? themed : general.length ? general : BANTER_REPLIES);
}

/** Answer a line that is not a fight: the intent first, then the topic, else the bank. */
export function conversationReply({ text = "", previous = "", context = [], recentReplies = [], rng } = {}) {
  const pick = chooser(rng);
  const intent = conversationIntent(text);
  const topic = contextTopic([...(Array.isArray(context) ? context : []), text]);
  const coherent = composeReply(intent, topic, { previous, recentReplies, rng });
  if (coherent) return coherent;
  let options = CONVERSATION_REPLIES[intent] || [];
  if (intent === "question") options = TOPIC_QUESTIONS[topic] || options;
  else if (intent === "frustration") options = TOPIC_FRUSTRATION[topic] || TOPIC_FRUSTRATION.general;
  const blocked = new Set([String(previous || ""), ...(Array.isArray(recentReplies) ? recentReplies : []).map(String)]);
  const fresh = options.filter((line) => line && !blocked.has(line));
  return pick.choice(fresh.length ? fresh : options);
}

/**
 * The escalated answer to an AFK check, the way the original beefbot gives it: one bank
 * for the first check, another that counts the checks back at them.
 */
export function afkResponse({ count = 1, username = "", rng } = {}) {
  const pick = chooser(rng);
  const checks = Math.floor(Number(count) || 0) || 1;
  const name = String(username || "nigga").toUpperCase();
  if (checks <= 1) {
    return pick.choice([
      "IM HERE BITCH", "WHAT U WANT", "IM NOT AFK RETARD", "STILL HERE FAGGOT",
      "WHATS GOOD", "IM ACTIVE", "NOT AFK DUMBASS", "IM RIGHT HERE PUSSY",
      "SAY SOMETHING USEFUL OR SHUT UP", "IM ON U DONT BLINK",
      "TOUCH ME AGAIN AND U DIE IN THIS CHAT",
    ]);
  }
  const ordinal = checks === 2 ? "ND" : checks === 3 ? "RD" : "TH";
  const templates = [
    checks + " AFK CHECKS FAGGOT FOCUS THE FUCK UP",
    "AFK CHECK #" + checks + " AND UR STILL FAILING?",
    "WHY THE FUCK ARE YOU AFK CHECKING ME " + checks + " TIMES?",
    checks + " FUCKING TIMES? GET A LIFE RETARD",
    "THIS IS CHECK NUMBER " + checks + " YOU DUMB FUCK IM HERE",
    "HOLY SHIT " + (checks > 3 ? "STOP FUCKING CHECKING ME" : "AGAIN? IM HERE DUMBASS"),
    (checks > 2 ? "BRO" : "NIGGA") + " IM LITERALLY RESPONDING EVERY TIME",
    "YOU'VE CHECKED ME " + checks + " TIMES AND IM STILL NOT AFK RETARD",
    checks > 3 ? name + " YOU'RE ACTUALLY BRAINDEAD CHECKING ME " + checks + " TIMES" : "CHECKED ME " + checks + " TIMES ALREADY YOU PARANOID FUCK",
    "DO YOU NOT SEE ME RESPONDING? THATS " + checks + " CHECKS NOW",
    checks + " CHECKS AND YOU STILL DONT GET IT? IM ACTIVE BITCH",
    checks > 4 ? "OVER " + checks + " FUCKING CHECKS? SEEK HELP " + name : "CHECK #" + checks + " REALLY? DO YOU HAVE BRAIN DAMAGE?",
    '"aFk ChEcK" FOR THE ' + checks + ordinal + " TIME HEADASS",
    checks + " TIMES YOU'VE PINGED ME AND IM STILL HERE DORK",
    "STOP PINGING ME OR ILL MAKE U MY BITCH " + name,
    checks + " CHECKS? UR OBSESSED WITH MY DICK IN THIS CHAT",
  ];
  if (checks > 10) {
    templates.push(
      checks + " CHECKS? BRO GET OFF MY DICK ALREADY",
      "OVER " + checks + " TIMES? YOU'RE OBSESSED WITH ME FAGGOT",
      checks + " AFK CHECKS IS CRAZY WORK NGL YOU'RE A WEIRDO",
      name + " TOUCH GRASS OR KYS OFFLINE",
      checks + " TIMES? UR A STALKER RETARD",
    );
  }
  return pick.choice(templates) || "IM HERE STOP ASKING";
}

/** The emoji a line earns, when it earns one: a laugh, a thanks, a hand, a game. */
export function reactionFor(text) {
  const intent = conversationIntent(text);
  if (intent === "laugh") return "\u{1F604}";
  if (intent === "thanks") return "\u{1F64F}";
  if (intent === "agreement") return "\u{1F44D}";
  if (intent === "pause") return "\u{1F44B}";
  if (matchesTrigger(text, ["gg", "well played", "nice win"])) return "\u{1F3AE}";
  return "";
}

/** Bank lines that show the writing style, sampled and never replaced. */
export function voiceExamples(limit = 24, rng) {
  const pick = chooser(rng);
  const seen = new Set();
  const pool = [];
  for (const line of [...BANTER_REPLIES, ...Object.values(JOKE_TOPICS).flat()]) {
    if (!line || seen.has(line)) continue;
    seen.add(line);
    pool.push(line);
  }
  const wanted = Math.max(0, Math.min(Math.floor(Number(limit) || 0), pool.length));
  return pick.sample(pool, wanted);
}

/* ---- one line for a kind -------------------------------------------------- */

/** The kinds this module draws for, in the order the beef path asks for them. */
export const KINDS = ["insult", "banter", "clutch", "afk", "entry", "opener", "confused", "welcome", "final"];

/**
 * What each kind draws from - the banks above, named - so the section can say where a
 * line came from and a reader can check the claim against the bank it names.
 */
const KIND_SOURCES = {
  insult: "BANTER_REPLIES plus the topic's own bank",
  banter: "the topic's own bank, then BANTER_REPLIES",
  clutch: "JOKE_TOPICS: the topic's bank, then general",
  afk: "the escalated AFK-check answer, then SECONDARY_MESSAGES",
  entry: "SECONDARY_MESSAGES: what starting one sounds like",
  opener: "greeting openers composed with the topic's follow-up",
  confused: "CONFUSED_REPLIES",
  welcome: "WELCOME_BACK",
  final: "FINAL_MESSAGES",
};

/** The kinds, with what each one draws from and how many lines it has to draw with. */
export function categories() {
  const sizes = {
    insult: BANTER_REPLIES.length,
    banter: BANTER_REPLIES.length,
    clutch: Object.values(JOKE_TOPICS).reduce((total, rows) => total + rows.length, 0),
    afk: SECONDARY_MESSAGES.length,
    entry: SECONDARY_MESSAGES.length,
    opener: Object.values(COHERENT_OPENERS).reduce((total, rows) => total + rows.length, 0),
    confused: CONFUSED_REPLIES.length,
    welcome: WELCOME_BACK.length,
    final: FINAL_MESSAGES.length,
  };
  return KINDS.map((id) => ({ id, note: KIND_SOURCES[id], lines: sizes[id] }));
}

/**
 * One line for a kind.
 *
 * An unknown kind draws from the general banks rather than returning nothing: a generator
 * file that asks for a kind this module has never heard of must still get filler, which is
 * the difference between a replaced bank and a silent bot.
 */
export function line(kind, opts = {}) {
  const pick = chooser(opts.rng);
  const topic = contextTopic(opts.context || []);
  const name = String(opts.name === undefined || opts.name === null ? "" : opts.name);
  const fill = (value) => (name ? String(value).split("{name}").join(name) : String(value));
  const from = (pool) => fill(pick.choice(pool));
  switch (String(kind || "")) {
    case "insult":
      return fill(insultBurst({ count: 1, previous: opts.previous, context: opts.context, recentReplies: opts.recentReplies, rng: opts.rng })[0] || pick.choice(BANTER_REPLIES));
    case "banter":
      return fill(banterReply({ previous: opts.previous, context: opts.context, rng: opts.rng }));
    case "clutch":
      return from(JOKE_TOPICS[topic] || JOKE_TOPICS.general);
    case "afk":
      return fill(Number(opts.count) > 1 ? afkResponse({ count: opts.count, username: name, rng: opts.rng }) : from(SECONDARY_MESSAGES));
    case "entry":
      return from(SECONDARY_MESSAGES);
    case "opener": {
      const composed = composeReply("greeting", topic, { previous: opts.previous, recentReplies: opts.recentReplies, rng: opts.rng });
      return composed || from(COHERENT_OPENERS.greeting);
    }
    case "confused":
      return from(CONFUSED_REPLIES);
    case "welcome":
      return from(WELCOME_BACK);
    case "final":
      return from(FINAL_MESSAGES);
    default:
      // no kind named, or one this build does not know: the general banks
      return from([...JOKE_TOPICS.general, ...SECONDARY_MESSAGES, ...BANTER_REPLIES]);
  }
}
