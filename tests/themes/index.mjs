// language: JavaScript, file: tests/themes/index.mjs
//
// The theme system, exercised as plain node (it imports nothing from electron):
//
//   node tests/themes/index.mjs
//
// The load-bearing checks are the quiet ones: a theme that is not enabled is
// never read, and an online theme is fetched exactly once - at the moment it is
// installed - and never again, which is what "zero idle timers" means here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createThemes, sanitizeCss } from "../../src/themes.js";

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

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-themes-"));
const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-theme-src-"));
const themesDir = path.join(home, "themes");
const filesIn = (dir) => {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return -1;
  }
};

const ALPHA = "/* alpha */\n.alpha { color: red; }";
const BETA = "/* beta */\n.beta { color: blue; }";
fs.writeFileSync(path.join(srcDir, "alpha.theme.css"), ALPHA);
fs.writeFileSync(path.join(srcDir, "beta.theme.css"), BETA);

const logs = [];
let fetchCalls = 0;
const onlineBody = { ok: true, status: 200, text: async () => "/* online */\n.o { color: green; }" };
const fetchImpl = async () => {
  fetchCalls += 1;
  return onlineBody;
};

const themes = createThemes({ userData: home, log: (l) => logs.push(l), fetchImpl });

/* ---- 1. nothing enabled: nothing is injected ----------------------------- */

ok("an empty theme set injects nothing", themes.css() === "", JSON.stringify(themes.css()));
ok("it starts with an empty list", themes.list().length === 0, JSON.stringify(themes.list()));

/* ---- 2. a local theme: install, list, enable, render --------------------- */

const alpha = await themes.install(path.join(srcDir, "alpha.theme.css"), "Alpha");
ok("a local theme installs", alpha.ok === true && alpha.id === "alpha", JSON.stringify(alpha));
ok("and it appears in the list as local", themes.list().length === 1 && themes.list()[0].source === "local", JSON.stringify(themes.list()));
ok("installing does not switch it on", themes.list()[0].enabled === false);
ok("so nothing is injected yet", themes.css() === "", JSON.stringify(themes.css()));

themes.setEnabled("alpha", true);
ok("an enabled theme injects exactly its own css", themes.css() === ALPHA, JSON.stringify(themes.css()));
ok("an unknown theme cannot be enabled", themes.setEnabled("nope", true).ok === false);

/* ---- 3. a disabled theme is never read from disk ------------------------- */

const beta = await themes.install(path.join(srcDir, "beta.theme.css"), "Beta");
ok("a second local theme installs", beta.ok === true && beta.id === "beta", JSON.stringify(beta));
// the stored copy is deleted while the theme is off: if css() read it anyway,
// this would throw or leak its text into the payload
fs.rmSync(path.join(home, "themes", "beta.theme.css"), { force: true });
ok("a disabled theme is not read, even when its file is gone", themes.css() === ALPHA, JSON.stringify(themes.css()));
ok("its text never appears in the payload", !themes.css().includes("beta"));
themes.setEnabled("beta", true);
ok("enabling a theme whose file vanished degrades instead of throwing", themes.css() === ALPHA, JSON.stringify(themes.css()));
themes.setEnabled("beta", false);
ok("and disabling it again is the same payload", themes.css() === ALPHA);
fs.writeFileSync(path.join(home, "themes", "beta.theme.css"), BETA); // put it back

/* ---- 4. quick css comes after the themes --------------------------------- */

themes.setEnabled("beta", true);
ok("two enabled themes both inject", themes.css().includes(ALPHA) && themes.css().includes(BETA));
ok("themes keep the order they were added in", themes.css().indexOf("alpha") < themes.css().indexOf("beta"));
const quick = themes.setQuickCss(".quick { opacity: .5; }");
ok("quick css is accepted", quick.ok === true);
ok("quick css is appended after the themes", themes.css().indexOf("alpha") < themes.css().indexOf("quick"));
ok("quick css reads back", themes.quickCss() === ".quick { opacity: .5; }", themes.quickCss());

/* ---- 5. an online theme fetches once, at install, and never again -------- */

const before = fetchCalls;
const online = await themes.install("https://themes.example/hyper.theme.css");
ok("an online theme installs from a url", online.ok === true, JSON.stringify(online));
ok("it fetched exactly once", fetchCalls - before === 1, "calls " + (fetchCalls - before));
ok("it is recorded as online with its url", themes.list().find((t) => t.id === online.id).source === "online", JSON.stringify(themes.list().find((t) => t.id === online.id)));
themes.setEnabled(online.id, true);
const rendered = themes.css();
ok("the fetched css renders from the file, not the network", rendered.includes(".o { color: green; }"), rendered);
themes.list();
themes.css();
themes.setEnabled(online.id, false);
themes.setEnabled(online.id, true);
themes.state();
themes.quickCss();
themes.css();
ok("nothing fetches in the background after install", fetchCalls - before === 1, "calls " + (fetchCalls - before));

/* ---- 6. a hostile theme is refused and writes nothing -------------------- */

const hostileBodies = [
  "/* x */ } </style><script>alert(1)</script>",
  "@import url(//evil.example/x.css);",
  ".a { background: url(javascript:alert(1)); }",
  ".a { width: expression(alert(1)); }",
];
const hostileFetch = async () => {
  fetchCalls += 1;
  return { ok: true, status: 200, text: async () => hostileBodies[fetchCalls % hostileBodies.length] };
};
const careful = createThemes({ userData: home, log: () => {}, fetchImpl: hostileFetch });
const countBefore = filesIn(themesDir);
const listBefore = careful.list().length;
for (let i = 0; i < hostileBodies.length; i += 1) {
  const bad = hostileBodies[i];
  const direct = sanitizeCss(bad);
  ok("the sanitiser refuses " + JSON.stringify(bad.slice(0, 24)), direct.ok === false && direct.error.length > 0, JSON.stringify(direct));
  const res = await careful.install("https://themes.example/bad-" + i + ".theme.css");
  ok("install refuses it with an error, not a throw", res.ok === false && res.error.length > 0, JSON.stringify(res));
}
ok("a refused theme writes no file", filesIn(themesDir) === countBefore, "files " + filesIn(themesDir) + " before " + countBefore);
ok("a refused theme never enters the list", careful.list().length === listBefore);
const badQuick = careful.setQuickCss("@import url(//evil.example/x.css);");
ok("quick css is sanitised too", badQuick.ok === false && careful.quickCss() !== "@import url(//evil.example/x.css);", JSON.stringify(badQuick));
ok("a bad source reports instead of throwing", (await careful.install(path.join(srcDir, "absent.theme.css"))).ok === false);

/* ---- 7. state survives a fresh instance ---------------------------------- */

const again = createThemes({ userData: home, log: () => {} });
const ids = themes.list().map((t) => t.id).sort().join(",");
const ids2 = again.list().map((t) => t.id).sort().join(",");
ok("a fresh instance sees the same themes", ids === ids2, ids + " vs " + ids2);
const onNow = themes.list().filter((t) => t.enabled).map((t) => t.id).sort().join(",");
const onAgain = again.list().filter((t) => t.enabled).map((t) => t.id).sort().join(",");
ok("a fresh instance sees the same enabled flags", onNow === onAgain, onNow + " vs " + onAgain);
ok("a fresh instance sees the quick css", again.quickCss() === themes.quickCss());

/* ---- 8. remove drops it everywhere --------------------------------------- */

const removed = themes.remove("alpha");
ok("removing a theme succeeds", removed.ok === true);
ok("it leaves the list", !themes.list().some((t) => t.id === "alpha"));
ok("it leaves the payload", !themes.css().includes("alpha"), themes.css());

/* ---- 9. reload forgets a theme whose file is gone ------------------------ */

fs.rmSync(path.join(home, "themes", "beta.theme.css"), { force: true });
const reloaded = themes.reload();
ok("reload drops the theme whose file is gone", reloaded.dropped >= 1 && !themes.list().some((t) => t.id === "beta"), JSON.stringify(reloaded.dropped));
ok("and the payload no longer carries it", !themes.css().includes("beta"));

/* ---- 10. the library: read when asked for, cached, never fetched on its own --- */

// The published themes a browser can list. The stand-in answers by URL, because the
// library and a theme's CSS come from the same host with different paths: the index is
// JSON, the file is CSS, and both go out through this one fetch.
const LIBRARY = [
  {
    id: 47,
    name: "DTM-08",
    type: "theme",
    description: "a glossy theme",
    author: { github_name: "XYZenix" },
    tags: ["dark", "glossy"],
    likes: 3,
    downloads: 368,
    release_date: "2021-05-06T12:27:37.177Z",
    thumbnail_url: "https://themes.equicord.org/thumbnails/DTM-08_47.png",
    source: "https://github.com/XYZenix/DTM-08",
  },
  // The real index publishes both kinds - "theme" and "snippet" - so the browser's filter
  // reads the row rather than guessing from its description.
  { id: 12, name: "Quick Fix", type: "snippet", description: "one css rule", tags: [], likes: 1, downloads: 9 },
  { id: 9, description: "no name: this row has nothing to show" },
  "not an object at all",
];

let libraryCalls = 0;
let libraryStatus = 200;
const libraryCss = "/* library */\n.library { color: purple; }";
const libraryFetch = async (url) => {
  if (/\/themes$/.test(String(url))) {
    libraryCalls += 1;
    return { ok: libraryStatus === 200, status: libraryStatus, json: async () => LIBRARY, text: async () => JSON.stringify(LIBRARY) };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => libraryCss };
};

const libraryHome = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-library-"));
const library = createThemes({ userData: libraryHome, log: () => {}, fetchImpl: libraryFetch });

ok("a client that is only looking at its own themes fetches nothing", library.fetchCount() === 0, String(library.fetchCount()));

const first = await library.index();
ok("the library is read when it is asked for", first.ok === true && first.themes.length === 2, JSON.stringify(first).slice(0, 200));
const only = first.themes[0];
ok("and trimmed to what a card shows", only.name === "DTM-08" && only.author === "XYZenix" && /glossy/.test(only.description), JSON.stringify(only));
ok(
  "with the kind and the preview address the index publishes",
  only.kind === "theme" && only.thumbnail === "https://themes.equicord.org/thumbnails/DTM-08_47.png",
  JSON.stringify({ kind: only.kind, thumbnail: only.thumbnail }),
);
const snippetRow = first.themes.find((one) => one.kind === "snippet");
ok("and a row the index calls a snippet is listed as one", Boolean(snippetRow) && snippetRow.name === "Quick Fix", JSON.stringify(first.themes.map((one) => one.kind)));
ok("a row with no thumbnail says so rather than carrying an empty address", snippetRow.thumbnail === "", JSON.stringify(snippetRow.thumbnail));
ok("with the documented download url, built from the id", only.download === "https://api.themes.equicord.org/download/47", only.download);
ok("a row with no name is not a card", !first.themes.some((one) => one.download === "https://api.themes.equicord.org/download/9"), JSON.stringify(first.themes.map((one) => one.id)));
ok("reading it once cost one request", libraryCalls === 1, String(libraryCalls));

const cached = await library.index();
ok("asking again is answered from what was read, not the network", cached.cached === true && libraryCalls === 1, JSON.stringify({ cached: cached.cached, calls: libraryCalls }));

const forced = await library.index({ force: true });
ok("Load forces a fresh read", forced.cached === false && libraryCalls === 2, JSON.stringify({ cached: forced.cached, calls: libraryCalls }));

libraryStatus = 503;
const refused = await library.index({ force: true });
ok("a library that answers badly is an error, not an empty list", refused.ok === false && /503/.test(String(refused.error)), JSON.stringify(refused));
libraryStatus = 200;

// A theme installed from the library goes through the same door as a theme from a link:
// fetched once, at the moment of install, then a file that rendering reads instead.
const installed = await library.install(only.download, only.name);
ok("a library theme installs like any other online theme", installed.ok === true && library.list().some((one) => one.id === installed.id), JSON.stringify(installed));
const reads = library.fetchCount();
library.setEnabled(installed.id, true);
library.css();
ok("and once installed, rendering it fetches nothing", library.fetchCount() === reads, String(library.fetchCount()));
fs.rmSync(libraryHome, { recursive: true, force: true });

/* ---- 10b. previews: fetched by the shell, drawn from a data url --------------- */

// A thumbnail is a picture on the library's host (one row of the real index keeps its on a
// stranger's GitHub Pages), and the page it would be drawn in has Discord's image policy
// rather than ours - so the bytes are fetched here and answered with a data URL. These are
// the four rules that keep that from being worse than no previews at all.
const previewHome = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-preview-"));
let previewCalls = 0;
let previewType = "image/png";
let previewSize = 8;
let previewStatus = 200;
const previewThemes = createThemes({
  userData: previewHome,
  log: () => {},
  fetchImpl: async (url) => {
    previewCalls += 1;
    return {
      ok: previewStatus === 200,
      status: previewStatus,
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? previewType : "") },
      arrayBuffer: async () => new Uint8Array(previewSize).buffer,
    };
  },
});
const goodPreview = "https://themes.equicord.org/thumbnails/DTM-08_47.png";
const fetched = await previewThemes.thumbnail(goodPreview);
ok("a preview is fetched here and handed over as a data url", fetched.ok === true && fetched.dataUrl.startsWith("data:image/png;base64,"), JSON.stringify(fetched).slice(0, 120));
ok("and it says how big it was", fetched.bytes === 8 && previewCalls === 1, JSON.stringify({ bytes: fetched.bytes, calls: previewCalls }));
const previewAgain = await previewThemes.thumbnail(goodPreview);
ok("asking for the same preview again costs nothing", previewAgain.cached === true && previewCalls === 1, JSON.stringify({ cached: previewAgain.cached, calls: previewCalls }));

const overHttp = await previewThemes.thumbnail("http://themes.equicord.org/x.png");
ok("a preview over http is refused", overHttp.ok === false, JSON.stringify(overHttp));
const strangerPreview = await previewThemes.thumbnail("https://evil.example/x.png");
ok("a preview on a host this client does not fetch is refused, and the answer names the host", strangerPreview.ok === false && /evil\.example/.test(strangerPreview.error), JSON.stringify(strangerPreview));
const notAnAddress = await previewThemes.thumbnail("not a url");
ok("something that is not an address is refused", notAnAddress.ok === false, JSON.stringify(notAnAddress));
ok("and none of those cost a request", previewCalls === 1, String(previewCalls));

previewType = "text/html";
const notAnImage = await previewThemes.thumbnail("https://themes.equicord.org/thumbnails/other.png");
ok("an answer that is not an image is refused", notAnImage.ok === false && /text\/html/.test(notAnImage.error), JSON.stringify(notAnImage));
previewType = "image/png";

previewSize = 5 * 1024 * 1024;
const huge = await previewThemes.thumbnail("https://themes.equicord.org/thumbnails/huge.png");
ok("a preview past the size cap is refused rather than held", huge.ok === false && /larger than/.test(huge.error), JSON.stringify(huge));
previewSize = 8;

previewStatus = 503;
const down = await previewThemes.thumbnail("https://api.themes.equicord.org/thumbnails/down.png");
ok("a preview that answers badly is an error, not a picture", down.ok === false && /503/.test(down.error), JSON.stringify(down));
previewStatus = 200;

const noFetch = createThemes({ userData: previewHome, log: () => {}, fetchImpl: null });
const noFetchAnswer = await noFetch.thumbnail(goodPreview);
ok("a run with no fetch available says so instead of throwing", noFetchAnswer.ok === false && /no fetch/.test(noFetchAnswer.error), JSON.stringify(noFetchAnswer));
// four requests in total: the one that was cached, the one that answered the wrong type, the
// one that was too big and the one that answered 503. The three refusals happen before any
// request is made, which is the point of refusing them there.
ok("and the refusals that need no network cost no request", previewCalls === 4, String(previewCalls));
fs.rmSync(previewHome, { recursive: true, force: true });

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(srcDir, { recursive: true, force: true });

/* ---- 11. imports: allowed from the hosts themes really use, lifted to the top ------ */

// Published themes import their own modules and their fonts, and refusing the statement
// outright refused most of the library ("install Novum: @import is not allowed in a
// theme"). So it is an allow-list now, and what is refused says which host was the problem.
const googleFont = sanitizeCss('@import url("https://fonts.googleapis.com/css2?family=Inter");\n.x { color: red; }');
ok("an https @import from a host themes use is allowed", googleFont.ok === true, JSON.stringify(googleFont));
const bareString = sanitizeCss('@import "https://raw.githubusercontent.com/x/y/main/base.css";\n.y { color: blue; }');
ok("the bare-string form is read the same way", bareString.ok === true, JSON.stringify(bareString));
const strangerHost = sanitizeCss('@import url("https://evil.example/x.css");\n.z { color: green; }');
ok(
  "an @import from anywhere else is refused, and the message names the host",
  strangerHost.ok === false && /evil\.example/.test(strangerHost.error),
  JSON.stringify(strangerHost),
);
ok("a relative @import is refused", sanitizeCss('@import "x.css";\n.w { color: red; }').ok === false, JSON.stringify(sanitizeCss('@import "x.css";')));
ok("a plain http @import is refused", sanitizeCss('@import url("http://fonts.googleapis.com/x.css");\n.v { color: red; }').ok === false, "");

// The import has to survive the trip: CSS ignores an @import that is not before every other
// rule, and this client injects one sheet rather than one element per theme.
const importHome = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-import-"));
fs.mkdirSync(path.join(importHome, "themes"), { recursive: true });
fs.writeFileSync(
  path.join(importHome, "themes", "fonted.theme.css"),
  '@import url("https://fonts.googleapis.com/css?family=Inter");\n\n.fonted { color: red; }',
);
const importThemes = createThemes({ userData: importHome, log: () => {} });
const installedImport = await importThemes.install("fonted.theme.css", "Fonted");
ok("a theme that imports a font installs", installedImport.ok === true, JSON.stringify(installedImport));
importThemes.setEnabled(installedImport.id, true);
importThemes.setQuickCss(".quick { opacity: .5; }");
const payload = importThemes.css();
ok(
  "and its @import is lifted to the top of the payload, where CSS will honour it",
  payload.startsWith("@import") && /fonted/.test(payload) && /quick/.test(payload),
  JSON.stringify(payload.slice(0, 140)),
);
fs.rmSync(importHome, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
