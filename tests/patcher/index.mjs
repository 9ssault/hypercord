// language: JavaScript, file: tests/patcher/index.mjs
//
// The patcher, exercised against synthetic Discord installs rather than a real
// one, and the loader's two pure pieces against fake windows. What matters here
// is what the patch does to somebody's client: the original archive must survive
// byte for byte, a foreign resources/app must be left alone, a dry run must
// touch nothing, and a failure halfway through must put everything back.
//
//   node tests/patcher/index.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entrySource, findDiscord, inspect, launch, listInstalls, patch, unpatch } from "../../src/patcher.js";

const require = createRequire(import.meta.url);
const loader = require("../../src/loader.cjs");

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

const ENTRY_BYTES = Buffer.from("discord-app-asar-bytes-9191");
const ENTRY_BYTES_OLD = Buffer.from("discord-app-asar-bytes-9001");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-patcher-"));
const loaderFile = path.join(root, "loader.cjs");
fs.writeFileSync(loaderFile, "// the loader the patched entry point requires\n");

/** a clean linux-layout install inside the temp root */
function makeInstall(id, { version = "1.0.136", bytes = ENTRY_BYTES } = {}) {
  const config = path.join(root, id);
  const resources = path.join(config, "discord", "app-" + version, "resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar"), bytes);
  fs.writeFileSync(path.join(path.dirname(resources), "Discord"), "not really a binary");
  const found = findDiscord({ platform: "linux", env: { XDG_CONFIG_HOME: config }, home: root, packageRoots: [], flatpakFiles: [] });
  // discovery failure is reported as a failed check above; the patch checks below
  // still get an install of the right shape, so one problem does not lose the run
  const fallback = {
    channel: "stable",
    channelName: "Discord",
    version,
    root: path.dirname(path.dirname(resources)),
    resources,
    appAsar: path.join(resources, "app.asar"),
    originalAsar: path.join(resources, "hypercord.app.asar"),
    appDir: path.join(resources, "app"),
    manifest: path.join(resources, "app", "hypercord.json"),
    executable: "",
    appBundle: "",
    launchCommand: { cmd: "discord", args: [] },
    exists: (p) => fs.existsSync(p),
  };
  return { config, resources, found: { ok: found.ok, error: found.error, install: found.ok ? found.install : fallback } };
}

const tree = (dir) => {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      out.push(prefix + entry.name + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) walk(full, prefix + entry.name + "/");
    }
  };
  walk(dir, "");
  return out.join("|");
};

/* ---- 1. discovery -------------------------------------------------------- */

const winLocal = path.join(root, "winlocal");
for (const [channel, version, bytes] of [
  ["Discord", "1.0.9191", ENTRY_BYTES],
  ["Discord", "1.0.9001", ENTRY_BYTES_OLD],
  ["DiscordPTB", "1.0.9000", ENTRY_BYTES_OLD],
]) {
  const resources = path.join(winLocal, channel, "app-" + version, "resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar"), bytes);
  const exe = channel === "Discord" ? "Discord.exe" : "DiscordPTB.exe";
  fs.writeFileSync(path.join(winLocal, channel, "app-" + version, exe), "exe");
}

const win = findDiscord({ platform: "win32", env: { LOCALAPPDATA: winLocal }, home: root });
ok("windows discovery finds an install", win.ok === true, JSON.stringify(win.error));
ok("windows discovery prefers stable over ptb", win.ok && win.install.channel === "stable", win.install && win.install.channel);
ok("windows discovery picks the newest version", win.ok && win.install.version === "1.0.9191", win.install && win.install.version);
ok("and it knows which executable to start", win.ok && /Discord\.exe$/.test(win.install.executable), win.install && win.install.executable);
ok("and the layout we patch", win.ok && win.install.originalAsar === path.join(win.install.resources, "hypercord.app.asar"), win.install && win.install.originalAsar);
ok("listing returns every channel it found", listInstalls({ platform: "win32", env: { LOCALAPPDATA: winLocal }, home: root }).length === 3);

const linux = makeInstall("linux-cfg");
ok("linux discovery finds a config-layout install", linux.found.ok === true, JSON.stringify(linux.found.error));
ok("linux discovery reads the version out of app-<version>", linux.found.ok && linux.found.install.version === "1.0.136", linux.found.install && linux.found.install.version);
ok("linux discovery hands over the binary", linux.found.ok && linux.found.install.executable === path.join(path.dirname(linux.resources), "Discord"), linux.found.install && linux.found.install.executable);

const pkgRoot = path.join(root, "pkgroot", "discord");
fs.mkdirSync(path.join(pkgRoot, "resources"), { recursive: true });
fs.writeFileSync(path.join(pkgRoot, "resources", "app.asar"), ENTRY_BYTES);
const pkg = findDiscord({ platform: "linux", env: { XDG_CONFIG_HOME: path.join(root, "empty-cfg") }, home: root, packageRoots: [pkgRoot], flatpakFiles: [] });
ok("a package-managed install is found too", pkg.ok === true && pkg.install.root === pkgRoot, JSON.stringify(pkg.error));

const flatpakApp = path.join(root, "flatpak", "com.discordapp.Discord");
const flatpakResources = path.join(flatpakApp, "current", "active", "files", "discord", "resources");
fs.mkdirSync(flatpakResources, { recursive: true });
fs.writeFileSync(path.join(flatpakResources, "app.asar"), ENTRY_BYTES);
const flatpakOptions = { platform: "linux", env: { XDG_CONFIG_HOME: path.join(root, "empty-cfg") }, home: root, packageRoots: [], flatpakFiles: [path.join(root, "flatpak")] };
const flat = findDiscord(flatpakOptions);
ok("a flatpak deployment is found", flat.ok === true && flat.install.root === path.join(flatpakApp, "current", "active", "files", "discord"), JSON.stringify(flat.error));
ok("flatpak is started through flatpak run", flat.ok && flat.install.launchCommand.cmd === "flatpak" && flat.install.launchCommand.args[1] === "com.discordapp.Discord", JSON.stringify(flat.install && flat.install.launchCommand));

const macResources = path.join(root, "Applications", "Discord.app", "Contents", "Resources");
fs.mkdirSync(macResources, { recursive: true });
fs.writeFileSync(path.join(macResources, "app.asar"), ENTRY_BYTES);
fs.writeFileSync(path.join(root, "Applications", "Discord.app", "Contents", "Info.plist"), "<key>CFBundleShortVersionString</key><string>1.2.3</string>");
const mac = findDiscord({ platform: "darwin", env: {}, home: root, appBases: [path.join(root, "Applications")] });
ok("macos discovery reads the bundle", mac.ok === true && /Discord\.app$/.test(mac.install.appBundle), JSON.stringify(mac.error));
ok("macos discovery reads the version from the plist", mac.ok && mac.install.version === "1.2.3", mac.install && mac.install.version);
ok("macos installs are started with open -a", mac.ok && mac.install.launchCommand.cmd === "open" && mac.install.launchCommand.args[0] === "-a", JSON.stringify(mac.install && mac.install.launchCommand));

const none = findDiscord({ platform: "linux", env: { XDG_CONFIG_HOME: path.join(root, "nothing") }, home: root, packageRoots: [], flatpakFiles: [] });
ok("no install reports a reason instead of throwing", none.ok === false && none.error.length > 0, JSON.stringify(none.error));

/* ---- 2. patching -------------------------------------------------------- */

const a = makeInstall("a");
const before = fs.readFileSync(path.join(a.resources, "app.asar"));
const cleanTree = tree(a.resources);
ok("a fresh install inspects as clean", inspect(a.found.install).state === "clean");

const dry = patch(a.found.install, { loader: loaderFile, dryRun: true });
ok("a dry run reports what it would do", dry.ok === true && dry.dryRun === true && dry.steps.length >= 4, JSON.stringify(dry.steps));
ok("a dry run touches nothing", tree(a.resources) === cleanTree);

const done = patch(a.found.install, { loader: loaderFile });
ok("patching succeeds", done.ok === true, JSON.stringify(done.error));
ok("the original archive is moved aside, not rewritten", fs.existsSync(path.join(a.resources, "hypercord.app.asar")) && !fs.existsSync(path.join(a.resources, "app.asar")));
ok("and it is byte for byte the client's own archive", fs.readFileSync(path.join(a.resources, "hypercord.app.asar")).equals(before));
ok("the entry directory is created with a package.json and an index.js", fs.existsSync(path.join(a.resources, "app", "package.json")) && fs.existsSync(path.join(a.resources, "app", "index.js")));
const entry = fs.readFileSync(path.join(a.resources, "app", "index.js"), "utf8");
ok("the entry point requires our loader", entry.includes('require(' + JSON.stringify(loaderFile) + ")"), entry.split("\n")[2]);
ok("the entry point hands off to the real client", entry.includes('module.exports = require("../hypercord.app.asar")'), entry.split("\n").pop());
ok("a loader failure never stops Discord from starting", /try \{[\s\S]*catch \(err\)[\s\S]*module\.exports = require/.test(entry));
ok("the manifest records that this is ours", JSON.parse(fs.readFileSync(path.join(a.resources, "app", "hypercord.json"), "utf8")).tool === "hypercord");
ok("the install now inspects as patched", inspect(a.found.install).state === "patched");

const again = patch(a.found.install, { loader: loaderFile });
ok("patching twice is idempotent", again.ok === true && again.already === true, JSON.stringify(again));
ok("its bytes are still the client's own", fs.readFileSync(path.join(a.resources, "hypercord.app.asar")).equals(before));

const rolled = unpatch(a.found.install);
ok("unpatching succeeds", rolled.ok === true && rolled.state === "clean", JSON.stringify(rolled));
ok("app.asar comes back byte for byte", fs.readFileSync(path.join(a.resources, "app.asar")).equals(before));
ok("the moved copy is gone", !fs.existsSync(path.join(a.resources, "hypercord.app.asar")));
ok("and nothing of ours is left behind", !fs.existsSync(path.join(a.resources, "app")));
ok("the directory is exactly as it was", tree(a.resources) === cleanTree, tree(a.resources));

const b = makeInstall("b");
fs.mkdirSync(path.join(b.resources, "app"), { recursive: true });
fs.writeFileSync(path.join(b.resources, "app", "index.js"), "// somebody else's loader\n");
const foreignTree = tree(b.resources);
const refused = patch(b.found.install, { loader: loaderFile });
ok("a foreign resources/app is refused", refused.ok === false && refused.state === "foreign", JSON.stringify(refused));
ok("and nothing at all is touched", tree(b.resources) === foreignTree);
ok("unpatching a foreign install is refused too", unpatch(b.found.install).ok === false);

const c = makeInstall("c");
fs.renameSync(path.join(c.resources, "app.asar"), path.join(c.resources, "hypercord.app.asar"));
ok("an install whose original was moved but has no entry is recognised", inspect(c.found.install).state === "half");
const repaired = patch(c.found.install, { loader: loaderFile });
ok("patching repairs that state", repaired.ok === true && inspect(c.found.install).state === "patched", JSON.stringify(repaired));
ok("and the client's archive is still intact", fs.readFileSync(path.join(c.resources, "hypercord.app.asar")).equals(before));
ok("unpatching the repaired install restores it", unpatch(c.found.install).ok === true && fs.existsSync(path.join(c.resources, "app.asar")));

const d = makeInstall("d");
const noLoader = patch(d.found.install, { loader: path.join(root, "absent-loader.cjs") });
ok("patching without a loader is refused", noLoader.ok === false && /not here/.test(noLoader.error), JSON.stringify(noLoader));
ok("and the install is untouched", inspect(d.found.install).state === "clean");

// rollback: an install whose entry directory cannot be created, because a file
// sits where a directory would have to be
const e = makeInstall("e");
fs.writeFileSync(path.join(e.resources, "blocked"), "a file, not a directory");
const broken = {
  ...e.found.install,
  appDir: path.join(e.resources, "blocked", "app"),
  manifest: path.join(e.resources, "blocked", "app", "hypercord.json"),
};
const failedPatch = patch(broken, { loader: loaderFile });
ok("a patch that cannot finish reports the failure", failedPatch.ok === false && /rolled back/.test(failedPatch.error), JSON.stringify(failedPatch));
ok("and it rolls the rename back", fs.existsSync(path.join(e.resources, "app.asar")) && !fs.existsSync(path.join(e.resources, "hypercord.app.asar")));
ok("so the client is exactly as it was found", fs.readFileSync(path.join(e.resources, "app.asar")).equals(before) && inspect(e.found.install).state === "clean");

// what the patch bakes in, so a patched install has something to show without a
// second file being found at launch time. The stylesheet is the whole payload now:
// the rail markup it used to carry alongside the css is gone, so a baked asset set
// with an html half in it is exactly what must not be recorded.
const bakedLoaderDir = path.join(root, "baked-loader");
fs.mkdirSync(bakedLoaderDir, { recursive: true });
fs.writeFileSync(path.join(bakedLoaderDir, "loader.cjs"), "// loader\n");
// The file beside the loader is `hypercord.json`, in the one shape the patch itself
// writes (`{ assets: { css } }`). The `rail.json` a previous release left there is
// written too, with its own css, so that reading the stale name is a failure rather
// than something this test cannot tell apart: exactly one of the two may be baked.
fs.writeFileSync(
  path.join(bakedLoaderDir, "rail.json"),
  JSON.stringify({ css: ".stale{}", html: "<b>rail</b>", side: "left" }),
);
fs.writeFileSync(
  path.join(bakedLoaderDir, "hypercord.json"),
  JSON.stringify({ tool: "hypercord", assets: { css: ".baked{}" } }),
);
const f = makeInstall("f");
const bakedPatch = patch(f.found.install, { loader: path.join(bakedLoaderDir, "loader.cjs") });
const bakedManifest = JSON.parse(fs.readFileSync(path.join(f.resources, "app", "hypercord.json"), "utf8"));
ok("an assets file beside the loader is baked into the patch", bakedPatch.ok === true && bakedManifest.assets.css === ".baked{}", JSON.stringify(bakedManifest.assets));
ok("the stale rail.json beside it is not what was read", !JSON.stringify(bakedManifest.assets).includes(".stale{}"), JSON.stringify(bakedManifest.assets));
ok("and nothing of the rail's markup is baked with it", !bakedManifest.assets.html && !bakedManifest.assets.rail && !bakedManifest.assets.side, JSON.stringify(bakedManifest.assets));
ok("the loader then finds it from what the patch wrote", loader.loadConfig({ mainDir: path.join(f.resources, "app"), dir: path.join(root, "nowhere"), env: {} }).css === ".baked{}");
ok("that install unpatches like any other", unpatch(f.found.install).ok === true);

// the caller's own assets are the other source, and they win over the file
const g = makeInstall("g");
const callerPatch = patch(g.found.install, { loader: path.join(bakedLoaderDir, "loader.cjs"), assets: { css: ".caller{}" } });
const callerManifest = JSON.parse(fs.readFileSync(path.join(g.resources, "app", "hypercord.json"), "utf8"));
ok("assets handed to the patch are what it records", callerPatch.ok === true && callerManifest.assets.css === ".caller{}", JSON.stringify(callerManifest.assets));
ok("and the loader reads those back too", loader.loadConfig({ mainDir: path.join(g.resources, "app"), dir: path.join(root, "nowhere"), env: {} }).css === ".caller{}");
ok("that install unpatches like any other", unpatch(g.found.install).ok === true);

const m = makeInstall("m");
const missingAsar = { ...m.found.install, resources: path.join(root, "no-resources") };
ok("an install with no resources reports rather than throws", patch(missingAsar, { loader: loaderFile }).ok === false);
ok("and unpatch does too", unpatch(missingAsar).ok === true && unpatch(missingAsar).already === true);

/* ---- 3. starting the real client ---------------------------------------- */

const calls = [];
const fakeSpawn = (cmd, args) => {
  calls.push({ cmd, args });
  return { unref() {} };
};
// discovered installs, or a stand-in that still answers the contract, so a
// discovery problem reports itself as a failed check instead of crashing the run
const standIn = (cmd, args = []) => ({ resources: root, appAsar: "", originalAsar: "", appDir: "", manifest: "", exists: () => true, launchCommand: { cmd, args } });
const winInstall = win.ok ? win.install : standIn(path.join(root, "Discord.exe"));
const macInstall = mac.ok ? mac.install : standIn("open", ["-a", path.join(root, "Discord.app")]);
const flatInstall = flat.ok ? flat.install : standIn("flatpak", ["run", "com.discordapp.Discord"]);

const startedMissing = launch(standIn(path.join(root, "nowhere", "Discord.exe")), { spawnImpl: fakeSpawn });
ok("launching a missing executable is a message, not a throw", startedMissing.ok === false && /not here/.test(startedMissing.error), JSON.stringify(startedMissing));

const started = launch(winInstall, { spawnImpl: fakeSpawn });
ok("launching a real install spawns it detached", started.ok === true && calls.length === 1 && /Discord\.exe$/.test(calls[0].cmd), JSON.stringify(calls));
ok("a mac install goes through open", (() => {
  const macCalls = [];
  const res = launch(macInstall, { spawnImpl: (cmd, args) => (macCalls.push([cmd, args]), { unref() {} }) });
  return res.ok === true && macCalls.length === 1 && macCalls[0][0] === "open" && macCalls[0][1][0] === "-a";
})());
ok("a flatpak install goes through flatpak run", (() => {
  const flatCalls = [];
  const res = launch(flatInstall, {
    spawnImpl: (cmd, args) => (flatCalls.push([cmd, args]), { unref() {} }),
  });
  return res.ok === true && flatCalls.length === 1 && flatCalls[0][0] === "flatpak" && flatCalls[0][1][0] === "run";
})());
ok("a spawn that throws is reported", launch(winInstall, { spawnImpl: () => { throw new Error("nope"); } }).ok === false);

/* ---- 4. the loader ------------------------------------------------------ */

const script = loader.buildInjection({ css: ".a { color: red; }" });
ok("the injection writes one style element", (script.match(/hypercord-theme/g) || []).length >= 2 && script.includes("document.createElement('style')"));
// the loader's whole footprint in Discord's page: one stylesheet. A host element, or
// any other node of ours in there, is what the rail used to be and must stay gone.
ok("and nothing else of ours is written into the page", !script.includes("createElement('div')") && !script.includes("hypercord-rail"));
ok("the injection carries the css as data", script.includes(JSON.stringify(".a { color: red; }")));
ok("the injection cannot break out of its own string", !loader.buildInjection({ css: 'x"; alert(1); "' }).includes('x"; alert(1); "'));
ok("the entry source is what the patcher writes", entrySource("/x/loader.cjs").includes('require("/x/loader.cjs")'));

function fakeWindow({ loading = false } = {}) {
  const executed = [];
  const once = [];
  return {
    id: executed.length + 1,
    webContents: {
      executed,
      isLoading: () => loading,
      executeJavaScript: (s) => (executed.push(s), Promise.resolve({ ok: true })),
      once: (name, fn) => once.push({ name, fn }),
      fire: (name) => once.filter((h) => h.name === name).forEach((h) => h.fn()),
    },
  };
}

const first = fakeWindow();
const app = { BrowserWindow: { getAllWindows: () => [first] }, on: (name, fn) => (app.handlers = { ...(app.handlers || {}), [name]: fn }), handlers: {} };
const fireCreated = (win) => (app.handlers["browser-window-created"] || (() => {}))({}, win);
const res = loader.attach(app, { css: "body{}", log: () => {} });
ok("the loader attaches to a window that is already open", res.ok === true);
await tick();
ok("and injects into it exactly once", first.webContents.executed.length === 1, "executed " + first.webContents.executed.length);

const later = fakeWindow();
fireCreated(later);
await tick();
ok("and into a window created afterwards", later.webContents.executed.length === 1, "executed " + later.webContents.executed.length);

const loading = fakeWindow({ loading: true });
fireCreated(loading);
await tick();
ok("a window still loading is waited for, not injected into", loading.webContents.executed.length === 0);
loading.webContents.fire("did-finish-load");
await tick();
ok("and injected once its page is ready", loading.webContents.executed.length === 1);

fireCreated(later);
await tick();
ok("a window is never injected into twice", later.webContents.executed.length === 1, "executed " + later.webContents.executed.length);

const empty = loader.attach({ BrowserWindow: { getAllWindows: () => [] }, on: () => {} }, { css: "", log: () => {} });
ok("with nothing to inject it attaches nothing and says so", empty.ok === true && empty.injected === 0 && empty.empty === true, JSON.stringify(empty));
ok("attaching without an app reports instead of throwing", loader.attach(null, {}).ok === false);

const bakedDir = path.join(root, "baked");
fs.mkdirSync(bakedDir, { recursive: true });
fs.writeFileSync(path.join(bakedDir, "hypercord.json"), JSON.stringify({ tool: "hypercord", assets: { css: ".baked{}" } }));
const bakedConfig = loader.loadConfig({ mainDir: bakedDir, dir: path.join(root, "nnowhere"), env: {} });
ok("the loader reads what the patch baked in", bakedConfig.found.endsWith("hypercord.json") && bakedConfig.css === ".baked{}", JSON.stringify(bakedConfig));

const cfgFile = path.join(root, "cfg.json");
fs.writeFileSync(cfgFile, JSON.stringify({ css: ".cfg{}" }));
const cfgConfig = loader.loadConfig({ mainDir: "", dir: path.join(root, "nowhere"), env: { HYPERCORD_LOADER_CONFIG: cfgFile } });
ok("an explicit config wins", cfgConfig.found === cfgFile && cfgConfig.css === ".cfg{}", JSON.stringify(cfgConfig));
const nothing = loader.loadConfig({ mainDir: "", dir: path.join(root, "nowhere"), env: {} });
ok("with no config anywhere it reports nothing found", nothing.found === "" && nothing.css === "");

ok("the loader did not attach while being tested", loader.started.ok === false, JSON.stringify(loader.started));

fs.rmSync(root, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
