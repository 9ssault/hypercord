// language: JavaScript, file: tests/signin/index.mjs
//
// How a user token is handed to Discord, and how the client decides whether the
// sign-in worked.
//
// This is the piece that let "token login did not work" look like "signed in": the
// older code wrote from the page's own world - where discord.com has no storage at
// all - and reported success without ever looking at the result. What is asserted
// here is the mechanism that was measured against the live page:
//
//   * the write goes through a same-origin frame, whose own `localStorage` is what
//     the page still offers;
//   * the value is the raw token, never the JSON-quoted form the client reads back
//     with its quotes and Discord refuses;
//   * a sign-in is attempted on the app route, because the login page never
//     restores a session;
//   * and only where the client ends up says whether it worked.
//
//   node tests/signin/index.mjs
import { AUTH_PATHS, appRoute, decideSignIn, signInForms, tokenWriteScript } from "../../src/signin.js";

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

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
