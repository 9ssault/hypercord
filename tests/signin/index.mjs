// language: JavaScript, file: tests/signin/index.mjs
//
// How a user token is handed to Discord, and how the client decides whether the
// sign-in worked.
//
// This is the piece that let "token login did not work" look like "signed in": the
// older code wrote from the page's own world - where discord.com has no storage at
// all - and reported success without ever looking at the result. What is asserted
// here is what has actually been observed, and what has not:
//
//   * MEASURED: the write goes through a same-origin frame, whose own `localStorage`
//     is what the page still offers, and it reads back exactly;
//   * MEASURED: the value is the raw token, never the JSON-quoted form the client
//     would read back with its quotes and Discord refuses;
//   * MEASURED, and it is the correction this file now carries: the client did **not**
//     use that token (`used=false` in signin.log), so "the client reads
//     localStorage.token at boot" was an assumption and not a measurement. The
//     placements are ordered by evidence, and the probe exists to answer the open
//     question from the live page;
//   * MEASURED: a sign-in is attempted on the app route, because the login page never
//     restores a session, and only where the client ends up says whether it worked.
//
//   node tests/signin/index.mjs
import {
  AUTH_PATHS,
  appRoute,
  captureSessionScript,
  clientSignInScript,
  decideSignIn,
  looksLikeAuthName,
  looksLikeUserToken,
  pickClientAuth,
  pickIndexedTarget,
  signInCandidates,
  signInForms,
  storageProbeScript,
  tokenLoginScript,
  tokenWriteScript,
} from "../../src/signin.js";

let passed = 0;
let failed = 0;
function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log("ok   " + name);
  } else {
    failed += 1;
    console.log("FAIL " + name + (detail ? " | " + detail : ""));
  }
}

/* ---- what is written ----------------------------------------------------- */

const forms = signInForms("MTIz.abc.def");
const frameForm = forms[0];
const storageForm = forms[1];

ok("two places are tried, in a fixed order", forms.length === 2 && frameForm.how === "frame" && storageForm.how === "storage", JSON.stringify(forms.map((f) => f.how)));
ok("the frame write comes first: it is the one that works", frameForm.name === "same-origin frame", frameForm.name);
ok("the first write is the raw token", frameForm.value === "MTIz.abc.def", JSON.stringify(frameForm.value));
ok("and so is the second", storageForm.value === "MTIz.abc.def", JSON.stringify(storageForm.value));
ok("nothing is JSON-quoted: the client sends what it read straight to Discord", forms.every((f) => !f.value.startsWith('"')), JSON.stringify(forms.map((f) => f.value)));
ok("the two attempts differ in where, not in what", forms.every((f) => f.value === frameForm.value));
ok("an empty secret does not produce a nonsense value", signInForms("").every((f) => f.value === ""));
ok("nothing is written from a non-string", signInForms(undefined)[0].value === "" && signInForms(null)[0].value === "");
ok("forming the shapes never mutates the secret", (() => {
  const secret = "x.y.z";
  signInForms(secret);
  return secret === "x.y.z";
})());
ok("the names a caller reports are stable", forms.map((f) => f.name).join(", ") === "same-origin frame, storage", forms.map((f) => f.name).join(", "));

/* ---- the write itself, run the way the page runs it ---------------------- */

/** A storage object with just enough of the API to be believable. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    setItem: (key, value) => map.set(key, String(value)),
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    peek: (key) => (map.has(key) ? map.get(key) : null),
  };
}

/**
 * A document whose `createElement("iframe")` answers a frame with a storage of its
 * own - which is the whole point of the frame write, so the fake has to model it.
 */
function fakeDocument(storage) {
  const frame = {
    style: {},
    contentWindow: storage ? { localStorage: storage } : {},
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  const appended = [];
  return {
    frame,
    appended,
    body: { appendChild: (node) => appended.push(node) },
    documentElement: { appendChild: (node) => appended.push(node) },
    createElement: () => frame,
  };
}

/** Run one generated script with fakes in scope, as a page would. */
function run(script, { document, localStorage } = {}) {
  return new Function("document", "localStorage", "return " + script)(document, localStorage);
}

ok("the frame script is valid JavaScript", (() => {
  try {
    new Function("return " + tokenWriteScript(frameForm));
    return true;
  } catch {
    return false;
  }
})());
ok("and so is the storage one", (() => {
  try {
    new Function("return " + tokenWriteScript(storageForm));
    return true;
  } catch {
    return false;
  }
})());

const framed = fakeStorage();
const framedDoc = fakeDocument(framed);
const framedResult = run(tokenWriteScript(frameForm), { document: framedDoc, localStorage: undefined });
ok("the frame write reports where it wrote", framedResult === "ok:same-origin frame", framedResult);
ok("the token is in the frame's storage, raw", framed.peek("token") === "MTIz.abc.def", JSON.stringify(framed.peek("token")));
ok("the frame is added to the page", framedDoc.appended.length === 1 && framedDoc.appended[0] === framedDoc.frame);
ok("and taken away again", framedDoc.frame.removed === true);
ok("the frame is invisible", framedDoc.frame.style.display === "none", String(framedDoc.frame.style.display));

const boxed = fakeStorage();
const boxedDoc = fakeDocument(boxed);
const boxedResult = run(tokenWriteScript(storageForm), { document: boxedDoc, localStorage: boxed });
ok("the storage write reports where it wrote", boxedResult === "ok:this page's own storage", boxedResult);
ok("the token is in the page's storage, raw", boxed.peek("token") === "MTIz.abc.def", JSON.stringify(boxed.peek("token")));
ok("nothing is appended for the storage write", boxedDoc.appended.length === 0);

// The failures have to be reasons, not a silent nothing: the old write threw and
// was never looked at, which is what made a broken sign-in look successful.
const noFrameStorage = run(tokenWriteScript(frameForm), { document: fakeDocument(null), localStorage: undefined });
ok("a frame with no storage is answered as a reason", noFrameStorage.startsWith("err:") && /no storage/.test(noFrameStorage), noFrameStorage);
const noGlobal = run(tokenWriteScript(storageForm), { document: fakeDocument(null), localStorage: undefined });
ok("a page with no storage of its own is answered as a reason", noGlobal.startsWith("err:") && /no localStorage/.test(noGlobal), noGlobal);
const throwing = run(tokenWriteScript(frameForm), {
  document: {
    body: { appendChild: () => {} },
    createElement: () => ({
      style: {},
      contentWindow: {
        get localStorage() {
          throw new ReferenceError("localStorage is not defined");
        },
      },
      remove() {},
    }),
  },
  localStorage: undefined,
});
ok("a storage that throws is reported with its own name", throwing.startsWith("err:ReferenceError"), throwing);
const different = run(tokenWriteScript(frameForm), {
  document: fakeDocument({
    setItem: () => {},
    getItem: () => "something else",
    remove() {},
  }),
  localStorage: undefined,
});
ok("a storage that kept something else is not a success", different.startsWith("err:the frame kept"), different);
const secondPageDifferent = run(tokenWriteScript(storageForm), {
  document: fakeDocument(null),
  localStorage: { setItem: () => {}, getItem: () => "not ours" },
});
ok("the page's own storage is checked the same way", secondPageDifferent.startsWith("err:the page's storage kept"), secondPageDifferent);
// The script writes what it is handed, so the guard against a quoted value belongs
// where the value is chosen. What the write itself guarantees is exactness: a
// hand-back that differs by so much as a quote is refused, which is what makes
// "ok" mean those bytes are in the client's storage.
const quotedHandBack = run(tokenWriteScript(frameForm), {
  document: fakeDocument({ setItem: () => {}, getItem: () => '"MTIz.abc.def"', remove() {} }),
  localStorage: undefined,
});
ok("a storage that hands back a quoted value is refused", quotedHandBack.startsWith("err:the frame kept"), quotedHandBack);
ok("and no form ever carries a quoted value", signInForms("MTIz.abc.def").every((f) => f.value === "MTIz.abc.def"), JSON.stringify(signInForms("MTIz.abc.def").map((f) => f.value)));

/* ---- the route a session is restored on ---------------------------------- */

ok("the app route is where a sign-in is attempted", appRoute("https://discord.com/login") === "https://discord.com/app", appRoute("https://discord.com/login"));
ok("it is resolved against the page the window is on", appRoute("https://discord.test/channels/@me") === "https://discord.test/app", appRoute("https://discord.test/channels/@me"));
ok("a deep page keeps its own origin", appRoute("https://selfhosted.example/discord/login?x=1") === "https://selfhosted.example/app", appRoute("https://selfhosted.example/discord/login?x=1"));
ok("an unreadable address falls back to Discord", appRoute("") === "https://discord.com/app");
ok("and so does garbage", appRoute("not a url") === "https://discord.com/app", appRoute("not a url"));
ok("a non-string does not throw", appRoute(undefined) === "https://discord.com/app" && appRoute(null) === "https://discord.com/app");

/* ---- where the client ended up ------------------------------------------- */

ok("an auth route is a refusal", decideSignIn({ pathname: "/login" }) === "rejected");
for (const path of AUTH_PATHS) {
  ok("  " + path + " counts as an auth route", decideSignIn({ pathname: path }) === "rejected");
}
ok("a deeper auth route counts too", decideSignIn({ pathname: "/login/handler" }) === "rejected");
ok("the app's own routes are a sign-in", decideSignIn({ pathname: "/channels/@me" }) === "accepted");
ok("a guild route counts as well", decideSignIn({ pathname: "/channels/123/456" }) === "accepted");
ok("the decision does not depend on the token still being in storage", decideSignIn({ pathname: "/channels/@me", tokenPresent: false }) === "accepted");
ok("the app route itself is not an answer yet", decideSignIn({ pathname: "/app" }) === "waiting");
ok("a path that is neither is not an answer yet", decideSignIn({ pathname: "/" }) === "waiting");
ok("and an empty read is not an answer either", decideSignIn({}) === "waiting");
ok("the decision ignores case", decideSignIn({ pathname: "/LOGIN" }) === "rejected" && decideSignIn({ pathname: "/Channels/@me" }) === "accepted");
ok("a route that merely starts like an auth path is not one", decideSignIn({ pathname: "/loginfo" }) === "waiting", decideSignIn({ pathname: "/loginfo" }));
ok("a non-string pathname does not throw", decideSignIn({ pathname: null }) === "waiting");

/* ---- a token in storage decides nothing ---------------------------------- */

// The bug this whole file exists for: the old client read the token's presence in
// storage as the answer, so a token Discord had already refused still came out as a
// successful sign-in. Only where the client ended up is a witness.
ok(
  "a token still in storage does not make an auth route a sign-in",
  decideSignIn({ pathname: "/login", tokenPresent: true }) === "rejected",
  decideSignIn({ pathname: "/login", tokenPresent: true }),
);
for (const path of ["/login", "/register", "/verify"]) {
  ok("  " + path + " is refused with a token present", decideSignIn({ pathname: path, tokenPresent: true }) === "rejected");
}
ok("a deeper auth route with a token present is refused too", decideSignIn({ pathname: "/verify/xyz", tokenPresent: true }) === "rejected", decideSignIn({ pathname: "/verify/xyz", tokenPresent: true }));
ok("the answer is the same with the token and without it", decideSignIn({ pathname: "/channels/@me", tokenPresent: true }) === decideSignIn({ pathname: "/channels/@me", tokenPresent: false }));
ok("nor does any other field of the observation decide", decideSignIn({ pathname: "/login", verdict: "accepted", status: 200 }) === "rejected", decideSignIn({ pathname: "/login", verdict: "accepted", status: 200 }));

/* ---- the write shapes are made per call, and never rewritten -------------- */

// Both attempts carry the same secret, so a caller that edits one shape must not
// change what the other writes - and the next caller must not be handed a shape
// somebody already touched.
const firstCall = signInForms("MTIz.abc.def");
const secondCall = signInForms("MTIz.abc.def");
ok("two calls hand back independent lists", firstCall !== secondCall && firstCall.length === 2 && firstCall[0] !== secondCall[0]);
firstCall[0].value = "tampered";
ok("editing one call's shape does not reach the next call", secondCall[0].value === "MTIz.abc.def", JSON.stringify(secondCall[0].value));
ok("and the next caller is handed a fresh shape", signInForms("MTIz.abc.def")[0].value === "MTIz.abc.def");

/* ---- the value is the raw secret, whatever shape it arrives in ----------- */

ok("a number is taken as the text it is", signInForms(123456789).every((f) => f.value === "123456789"), JSON.stringify(signInForms(123456789)[0].value));
ok("zero is text, not an absence", signInForms(0)[0].value === "0", JSON.stringify(signInForms(0)[0].value));
const awkward = 'has "quotes" in it';
ok("a secret carrying quotes is written as it is, without escaping", signInForms(awkward).every((f) => f.value === awkward), JSON.stringify(signInForms(awkward)[0].value));
const awkwardStorage = fakeStorage();
const awkwardResult = run(tokenWriteScript(signInForms(awkward)[0]), { document: fakeDocument(awkwardStorage), localStorage: undefined });
ok("and it round-trips raw through the frame write", awkwardResult === "ok:same-origin frame" && awkwardStorage.peek("token") === awkward, awkwardResult + " | " + JSON.stringify(awkwardStorage.peek("token")));
ok("the framed value is never the quoted form", awkwardStorage.peek("token") !== JSON.stringify(awkward), JSON.stringify(awkwardStorage.peek("token")));

/* ---- a page with no body still gets the frame ---------------------------- */

// The live page is a single-page app: the frame cannot assume a <body> is there
// when the write runs, so the root element has to be enough.
const rootStorage = fakeStorage();
const rootFrame = { style: {}, contentWindow: { localStorage: rootStorage }, remove() {} };
const appendedToRoot = [];
const rootResult = run(tokenWriteScript(frameForm), {
  document: { body: null, documentElement: { appendChild: (node) => appendedToRoot.push(node) }, createElement: () => rootFrame },
  localStorage: undefined,
});
ok("the frame goes to the root element when the page has no body", rootResult === "ok:same-origin frame" && appendedToRoot.length === 1 && appendedToRoot[0] === rootFrame, rootResult + " | appended " + appendedToRoot.length);
ok("and the token still lands in the frame's storage", rootStorage.peek("token") === "MTIz.abc.def", JSON.stringify(rootStorage.peek("token")));

/* ---- the probe: facts about the page, and never a value ------------------ */

// The probe is the instrument that replaces the assumption. It may report *which*
// keys exist, their names, their lengths and their types - it may never report a
// value, and a cookie's value least of all. These assertions hold it to that.
// A token as the probe sees one. It is deliberately in the two-part `<id>.<signature>` form
// `looksLikeUserToken` accepts rather than the three-part one a *Discord* token comes in: the
// earlier fixture was three dot-separated base64url parts, which is the shape GitHub's push
// protection recognises as a live Discord token and refuses to accept a push of. What these
// assertions need is a string the client's own rule calls a session, not a real-looking one.
const LIVE_TOKEN = "hypercordTestTokenId0123456789.hypercordTestSignature0123456789abcdef";
const COOKIE_VALUE = "SHOULD-NOT-APPEAR-ANYWHERE";

/** A storage with the two members the probe walks: `length`/`key(i)` and getItem. */
function probeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (index) => Array.from(map.keys())[index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    peek: (key) => (map.has(key) ? map.get(key) : null),
  };
}

const probedPage = probeStorage({ token: LIVE_TOKEN, theme: "dark" });
const probedFrame = probeStorage({ __sentry: "1" });
const probeFrameNode = { style: {}, contentWindow: { localStorage: probedFrame, sessionStorage: probeStorage({}) }, remove() {} };
const probeDocument = {
  cookie: "__Secure-session=" + COOKIE_VALUE + "; locale=en-US",
  createElement: () => probeFrameNode,
  body: { appendChild: () => {} },
  documentElement: { appendChild: () => {} },
};
const probeReport = JSON.parse(
  await new Function("document", "localStorage", "sessionStorage", "indexedDB", "return " + storageProbeScript())(
    probeDocument,
    probedPage,
    probeStorage({}),
    undefined,
  ),
);
const probeText = JSON.stringify(probeReport);
const pageKeys = probeReport.page.localKeys;
ok("the probe reports key names in the page's own storage", Array.isArray(pageKeys) && pageKeys.some((key) => key.name === "token"), JSON.stringify(pageKeys));
ok("with lengths and types, not values", pageKeys.every((key) => typeof key.length === "number" && typeof key.auth === "boolean"), JSON.stringify(pageKeys));
ok("a key whose name speaks of auth is marked", pageKeys.find((key) => key.name === "token").auth === true);
ok("and an ordinary key is not", pageKeys.find((key) => key.name === "theme").auth === false);
ok("the frame's storage is reported separately from the page's", Array.isArray(probeReport.frame.localKeys) && probeReport.frame.localKeys[0].name === "__sentry", JSON.stringify(probeReport.frame));
ok("cookies are reported by name only", probeReport.cookies.includes("__Secure-session") && probeReport.cookies.includes("locale"), JSON.stringify(probeReport.cookies));
ok("no value reaches the report, whatever its source", !probeText.includes(LIVE_TOKEN) && !probeText.includes(COOKIE_VALUE), probeText.slice(0, 200));
ok("the token's length is what is reported, not the token", pageKeys.find((key) => key.name === "token").length === LIVE_TOKEN.length);
ok("a world without indexedDB is a note, not a failure", (probeReport.notes || []).some((note) => /indexedDB/i.test(note)), JSON.stringify(probeReport.notes));
// The client's own modules: the probe asks where the *client* keeps a session, not only
// where a page keeps keys. A world with no module registry is a note, never a throw, and
// the section may carry names only.
ok("the probe asks the client for its own modules", probeReport.client && typeof probeReport.client === "object", JSON.stringify(probeReport.client));
ok("a world with no module registry says so instead of failing", probeReport.client.registry === false && (probeReport.client.notes || []).some((note) => /registry/i.test(note)), JSON.stringify(probeReport.client));
ok("and it offers nothing to call there", Array.isArray(probeReport.client.candidates) && probeReport.client.candidates.length === 0);
ok("the client section carries no value either", !JSON.stringify(probeReport.client).includes(LIVE_TOKEN));
ok("the probe script is valid JavaScript", (() => {
  try {
    new Function("return " + storageProbeScript());
    return true;
  } catch {
    return false;
  }
})());

/* ---- the placements, ordered by evidence --------------------------------- */

const candidates = signInCandidates(LIVE_TOKEN);
ok("three placements are offered, in a fixed order", candidates.length === 3 && candidates.map((one) => one.how).join(",") === "frame,storage,indexeddb", JSON.stringify(candidates.map((one) => one.how)));
ok("every placement says why it is where it is", candidates.every((one) => typeof one.why === "string" && one.why.length > 30));
ok("and says whether its effect was measured", candidates[0].verified.length > 0 && candidates[1].verified.length > 0 && candidates[2].verified === "", JSON.stringify(candidates.map((one) => one.verified)));
ok("none of them claims the client consumed the token", candidates.every((one) => one.consumed === false));
ok("the raw secret goes into every placement", candidates.every((one) => one.value === LIVE_TOKEN));
ok("without a probe the indexeddb placement is not attempted and says why", Boolean(candidates[2].skipped) && /probe/.test(candidates[2].skipped), String(candidates[2].skipped));
ok("the two placements that were measured are attempted", !candidates[0].skipped && !candidates[1].skipped);
ok("a second call orders them the same way", signInCandidates(LIVE_TOKEN).map((one) => one.how).join(",") === candidates.map((one) => one.how).join(","));
ok("and hands back fresh placements", signInCandidates(LIVE_TOKEN)[0] !== candidates[0]);

const withProbe = signInCandidates(LIVE_TOKEN, {
  probe: { indexeddb: [{ database: "discord", stores: [{ store: "kv", keys: [{ name: "access_token", auth: true }] }] }] },
});
ok("a probe result turns the indexeddb placement into a named target", withProbe[2].skipped === "" && withProbe[2].database === "discord" && withProbe[2].store === "kv" && withProbe[2].key === "access_token", JSON.stringify(withProbe[2]));
ok("and its name says which store it will write to", /discord\/kv/.test(withProbe[2].name), withProbe[2].name);
ok("the first auth-looking key is the one chosen", pickIndexedTarget({ indexeddb: [{ database: "db", stores: [{ store: "s", keys: [{ name: "colour", auth: false }, { name: "token", auth: true }] }] }] }).key === "token");
ok("a store with nothing auth-looking is a fallback, not an answer", pickIndexedTarget({ indexeddb: [{ database: "db", stores: [{ store: "s", keys: [{ name: "colour", auth: false }] }] }] }).key === "token");
ok("an empty report offers nothing", pickIndexedTarget(null) === null && pickIndexedTarget({ indexeddb: [] }) === null);

ok("a placement the probe ruled out is answered as not attempted, with its reason", run(tokenWriteScript(candidates[2])).startsWith("err:not attempted:"), run(tokenWriteScript(candidates[2])));
ok("an indexeddb write with no target refuses with a reason", (await run(tokenWriteScript({ how: "indexeddb", value: LIVE_TOKEN, database: "", store: "" }))).startsWith("err:"));

/* ---- what counts as a captured session ----------------------------------- */

ok("a token-shaped string is recognised", looksLikeUserToken(LIVE_TOKEN));
ok("the quoted form is not", !looksLikeUserToken('"' + LIVE_TOKEN + '"'));
ok("nonsense is not", ["", "abc", "a.b.c", LIVE_TOKEN.replace(/\./g, ""), "x".repeat(40), null, undefined].every((value) => !looksLikeUserToken(value)));
ok("a string far too long to be one is not", !looksLikeUserToken("a".repeat(21) + "." + "b".repeat(21) + "." + "c".repeat(5000)));
ok("the name rule the page and the shell share", looksLikeAuthName("access_token") && looksLikeAuthName("Session") && !looksLikeAuthName("theme"));

/* ---- capture: the reliable half ------------------------------------------ */

const captureFrame = probeStorage({ token: LIVE_TOKEN });
const captureDoc = fakeDocument(captureFrame);
const captured = JSON.parse(await run(captureSessionScript(null), { document: captureDoc, localStorage: undefined }));
ok("capture names the place it read", captured.where === "frame storage" && captured.key === "token", JSON.stringify(captured));
ok("and hands the raw value to the shell, which stores it", captured.value === LIVE_TOKEN);
ok("capture does not fall through to the page when the frame answered", captureDoc.appended.length === 1);

const emptyCapture = JSON.parse(await run(captureSessionScript(null), { document: fakeDocument(probeStorage({})), localStorage: undefined }));
ok("a page with nothing to capture says so rather than guessing", emptyCapture.where === "" && emptyCapture.value === "", JSON.stringify(emptyCapture));

const storeCapture = JSON.parse(await run(captureSessionScript(null), { document: fakeDocument(null), localStorage: probeStorage({ token: LIVE_TOKEN }) }));
ok("the page's own storage is the next place tried", storeCapture.where === "page storage" && storeCapture.value === LIVE_TOKEN, JSON.stringify(storeCapture));

// Capture must read only what the probe named: a place nobody reported is a place it
// has no business opening, and the script it generates has to say exactly which.
const namedScript = captureSessionScript({ indexeddb: [{ database: "discord", stores: [{ store: "kv", keys: [{ name: "access_token", auth: true }] }] }] });
ok("capture is pointed at the store the probe named", namedScript.includes("indexeddb discord/kv") && namedScript.includes("access_token"));
// The generated script carries its own target list, so the claim can be checked
// exactly rather than read: every indexeddb target in it must be one the probe named.
const targetList = JSON.parse(namedScript.match(/const targets = (\[[\s\S]*?\]);/)[1]);
const indexedTargets = targetList.filter((target) => target.how === "indexeddb");
ok("every indexeddb target it reads is one the probe named", indexedTargets.length === 1 && indexedTargets[0].database === "discord" && indexedTargets[0].store === "kv" && indexedTargets[0].key === "access_token", JSON.stringify(indexedTargets));
ok("and the two storages are tried before any store", targetList[0].where === "frame storage" && targetList[1].where === "page storage", JSON.stringify(targetList.map((target) => target.where)));
ok("a probe with no indexeddb leaves capture with only the two storages", (() => {
  const bare = JSON.parse(captureSessionScript({}).match(/const targets = (\[[\s\S]*?\]);/)[1]);
  return bare.length === 2 && bare.every((target) => target.how !== "indexeddb");
})());
ok("capture is a script the page can run", (() => {
  try {
    new Function("return " + captureSessionScript({}));
    return true;
  } catch {
    return false;
  }
})());

/* ---- the client's own sign-in: only ever with a target the probe named ----- */

// The storage shapes are the older ecosystem's and this build ignores them. The other
// path is the client's own sign-in code, and it may only be called when the probe
// actually named a callable export - a guessed module id would be a guess, which is the
// mistake this whole file exists to stop repeating.
const probeWithClient = { client: { registry: true, require: true, candidates: [{ module: "42226", exports: ["getToken", "login"], auth: ["login"], callable: ["login"] }] } };
const chosen = pickClientAuth(probeWithClient);
ok("a callable auth export is what a sign-in calls", chosen && chosen.module === "42226" && chosen.method === "login", JSON.stringify(chosen));
ok("handleTokenLogin wins over the plainer names", pickClientAuth({ client: { candidates: [{ module: "1", callable: ["login", "handleTokenLogin"] }] } }).method === "handleTokenLogin");
ok("a store-less report offers nothing to call", pickClientAuth(null) === null && pickClientAuth({}) === null && pickClientAuth({ client: { candidates: [{ module: "1", callable: [] }] } }) === null);
ok("the client sign-in is not attempted without a target", run(clientSignInScript(LIVE_TOKEN, null)).startsWith("err:not attempted:"), run(clientSignInScript(LIVE_TOKEN, null)));
ok("and it says what was missing", /no callable auth export/.test(run(clientSignInScript(LIVE_TOKEN, {}))));
const clientScript = clientSignInScript(LIVE_TOKEN, probeWithClient);
ok("with a target it names the module and the method it will call", clientScript.includes("42226") && clientScript.includes("login"));
ok("and it is a script the page can run", (() => {
  try {
    new Function("return " + clientScript);
    return true;
  } catch {
    return false;
  }
})());

/** A registry that answers the probe's fake chunk with a require function. */
function fakeRegistry(cache) {
  const registry = [];
  registry.push = (chunk) => chunk[2]({ c: cache });
  return registry;
}
function runClient(script, cache) {
  const registry = fakeRegistry(cache);
  const world = { webpackChunkDiscord_app: registry };
  return new Function("window", "globalThis", "return " + script)(world, world);
}

// The call has to hand the client the raw token, and the answer may not contain it.
const calls = [];
const okAnswer = await runClient(clientScript, { 42226: { exports: { login: (token) => { calls.push(token); return true; } } } });
ok("the client's own sign-in is called with the raw token", calls.length === 1 && calls[0] === LIVE_TOKEN, JSON.stringify(calls.length));
ok("and the answer names what was called, without the token", okAnswer === "ok:client 42226.login returned boolean" && !okAnswer.includes(LIVE_TOKEN), okAnswer);

const refused = await runClient(clientScript, { 42226: { exports: { login: () => { throw new Error("token " + LIVE_TOKEN + " is not valid"); } } } });
ok("a refusal by the client is a reason, not our failure", refused.startsWith("err:") && /threw/.test(refused), refused);
ok("and the client's own message cannot carry the token out", !refused.includes(LIVE_TOKEN), refused);
const missing = await runClient(clientScript, {});
ok("a module that is gone says so", missing.startsWith("err:") && /not loaded/.test(missing), missing);
const notCallable = await runClient(clientScript, { 42226: { exports: { login: "a string, not a function" } } });
ok("an export that is not callable says so", notCallable.startsWith("err:") && /not callable/.test(notCallable), notCallable);
const noRegistry = new Function("return " + clientScript)();
ok("a page with no registry at all says so", String(await noRegistry).startsWith("err:") && /registry/.test(String(await noRegistry)), String(await noRegistry));

/* ---- the client's own token login --------------------------------------- */

// The storage placements above are the older ecosystem's and this build bounces them: the
// page's own localStorage throws, the write lands in a frame's, and the client routes to /app
// then straight back to /login. What *is* measured to work on 1.0.9262 is the client's own
// `loginToken`, found by props ("login", "logout") and called with the raw token - it lands
// on /channels/@me. These assertions pin that call, its answer, and its redaction.
const directScript = tokenLoginScript(LIVE_TOKEN);
ok("the token login names the client's own function", directScript.includes("loginToken") && directScript.includes("findByProps"));
ok("and it is a script the page can run", (() => {
  try {
    new Function("return " + directScript);
    return true;
  } catch {
    return false;
  }
})());
const directCalls = [];
const directAnswer = await runClient(directScript, {
  5: { exports: { loginToken: (token) => { directCalls.push(token); return Promise.resolve(); }, logout() {} } },
});
ok("the client's token login is called with the raw token", directCalls.length === 1 && directCalls[0] === LIVE_TOKEN, String(directCalls.length));
ok("and the answer says what was called, without the token", directAnswer === "ok:client loginToken" && !directAnswer.includes(LIVE_TOKEN), directAnswer);
const directRefused = await runClient(directScript, {
  5: { exports: { loginToken: () => { throw new Error("token " + LIVE_TOKEN + " refused by the client"); }, logout() {} } },
});
ok("a client refusal is a reason, redacted", directRefused.startsWith("err:") && !directRefused.includes(LIVE_TOKEN), directRefused);
const directMissing = await runClient(directScript, {});
ok("a page whose auth module is absent says so", directMissing.startsWith("err:") && /auth module/.test(directMissing), directMissing);
const directFallback = await runClient(directScript, { 5: { exports: { startSession(token) { directCalls.push(token); } } } });
ok("a build that only has startSession is signed in the same way", directFallback === "ok:client startSession" && directCalls.at(-1) === LIVE_TOKEN, directFallback);

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
