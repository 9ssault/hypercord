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

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(srcDir, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
