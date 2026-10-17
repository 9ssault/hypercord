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
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entrySource, findDiscord, inspect, launch, listInstalls, patch, patchFreshness, unpatch } from "../../src/patcher.js";

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
ok("linux starts the exact binary inside the install it patched", linux.found.ok && linux.found.install.launchCommand.cmd === linux.found.install.executable && path.isAbsolute(linux.found.install.launchCommand.cmd), JSON.stringify(linux.found.install && linux.found.install.launchCommand));

const pkgRoot = path.join(root, "pkgroot", "discord");
fs.mkdirSync(path.join(pkgRoot, "resources"), { recursive: true });
fs.writeFileSync(path.join(pkgRoot, "resources", "app.asar"), ENTRY_BYTES);
// the deb/tar layout keeps the binary beside `resources`, which is the one that has
// to be started: a bare `discord` goes through PATH and can be another copy entirely
fs.writeFileSync(path.join(pkgRoot, "Discord"), "not really a binary");
const pkg = findDiscord({ platform: "linux", env: { XDG_CONFIG_HOME: path.join(root, "empty-cfg") }, home: root, packageRoots: [pkgRoot], flatpakFiles: [] });
ok("a package-managed install is found too", pkg.ok === true && pkg.install.root === pkgRoot, JSON.stringify(pkg.error));
ok("and it starts the binary in its own root rather than whatever PATH resolves", pkg.ok && pkg.install.launchCommand.cmd === path.join(pkgRoot, "Discord"), JSON.stringify(pkg.install && pkg.install.launchCommand));

// the same rule the other way round: with no binary in the root, the documented name
// is what is left, because refusing to start is worse than the shell resolving it
const bareRoot = path.join(root, "pkgroot-bare", "discord");
fs.mkdirSync(path.join(bareRoot, "resources"), { recursive: true });
fs.writeFileSync(path.join(bareRoot, "resources", "app.asar"), ENTRY_BYTES);
const bare = findDiscord({ platform: "linux", env: { XDG_CONFIG_HOME: path.join(root, "empty-cfg") }, home: root, packageRoots: [bareRoot], flatpakFiles: [] });
ok("with no binary beside the resources it falls back to the command name", bare.ok && bare.install.launchCommand.cmd === "discord", JSON.stringify(bare.install && bare.install.launchCommand));

const flatpakApp = path.join(root, "flatpak", "com.discordapp.Discord");
const flatpakResources = path.join(flatpakApp, "current", "active", "files", "discord", "resources");
fs.mkdirSync(flatpakResources, { recursive: true });
fs.writeFileSync(path.join(flatpakResources, "app.asar"), ENTRY_BYTES);
const flatpakOptions = { platform: "linux", env: { XDG_CONFIG_HOME: path.join(root, "empty-cfg") }, home: root, packageRoots: [], flatpakFiles: [path.join(root, "flatpak")] };
const flat = findDiscord(flatpakOptions);
ok("a flatpak deployment is found", flat.ok === true && flat.install.root === path.join(flatpakApp, "current", "active", "files", "discord"), JSON.stringify(flat.error));
ok("flatpak is started through flatpak run", flat.ok && flat.install.launchCommand.cmd === "flatpak" && flat.install.launchCommand.args[1] === "com.discordapp.Discord", JSON.stringify(flat.install && flat.install.launchCommand));
ok("and its resources are the deployment's own directory", flat.ok && flat.install.resources === flatpakResources, flat.install && flat.install.resources);

const macResources = path.join(root, "Applications", "Discord.app", "Contents", "Resources");
fs.mkdirSync(macResources, { recursive: true });
fs.writeFileSync(path.join(macResources, "app.asar"), ENTRY_BYTES);
fs.writeFileSync(path.join(root, "Applications", "Discord.app", "Contents", "Info.plist"), "<key>CFBundleShortVersionString</key><string>1.2.3</string>");
const mac = findDiscord({ platform: "darwin", env: {}, home: root, appBases: [path.join(root, "Applications")] });
ok("macos discovery reads the bundle", mac.ok === true && /Discord\.app$/.test(mac.install.appBundle), JSON.stringify(mac.error));
ok("macos discovery reads the version from the plist", mac.ok && mac.install.version === "1.2.3", mac.install && mac.install.version);
ok("macos installs are started with open -a", mac.ok && mac.install.launchCommand.cmd === "open" && mac.install.launchCommand.args[0] === "-a", JSON.stringify(mac.install && mac.install.launchCommand));
ok("macos hands over the bundle's own resources directory", mac.ok && mac.install.resources === macResources && mac.install.root === path.join(root, "Applications", "Discord.app"), mac.install && mac.install.resources);
ok("and starts that exact bundle, not one the Finder resolves by name", mac.ok && mac.install.launchCommand.args[1] === mac.install.appBundle && path.isAbsolute(mac.install.appBundle), JSON.stringify(mac.install && mac.install.launchCommand.args));

// A second channel on macOS is a second bundle, and the same order decides between
// them as on Windows. The bundle name *is* the channel, so getting this wrong would
// mean patching PTB and starting stable.
const macPtbResources = path.join(root, "Applications", "Discord PTB.app", "Contents", "Resources");
fs.mkdirSync(macPtbResources, { recursive: true });
fs.writeFileSync(path.join(macPtbResources, "app.asar"), ENTRY_BYTES_OLD);
fs.writeFileSync(path.join(root, "Applications", "Discord PTB.app", "Contents", "Info.plist"), "<key>CFBundleShortVersionString</key><string>1.2.2</string>");
const macBoth = findDiscord({ platform: "darwin", env: {}, home: root, appBases: [path.join(root, "Applications")] });
ok("macos lists every bundle it found", macBoth.installs.length === 2 && macBoth.installs.map((one) => one.channel).join(",") === "stable,ptb", JSON.stringify(macBoth.installs.map((one) => one.channel)));
ok("and stable is the one it would patch", macBoth.ok && macBoth.install.channel === "stable" && macBoth.install.version === "1.2.3", macBoth.install && macBoth.install.channel);

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

/* ---- 2b. the same round trip, on every platform ------------------------- */

/**
 * The whole round trip on one install, whatever platform it came from: inspect,
 * patch, what the patch recorded, and unpatch putting the directory back exactly as
 * it was. The patch used to be exercised on the Linux config layout alone, which is
 * how a patch that only works where it was written goes unnoticed: a macOS bundle and
 * the two Linux shapes each hold a different tree.
 *
 * `version` is what the manifest must record, or null to skip that half - the
 * discovery above reports its own failures, and a stand-in install keeps the patch
 * checks running so one problem does not lose the run.
 */
function roundTrip(platform, install, { version }) {
  const archive = path.join(install.resources, "app.asar");
  const bytes = fs.readFileSync(archive);
  const clean = tree(install.resources);
  ok(platform + ": the install inspects as clean", inspect(install).state === "clean", inspect(install).state);
  const done = patch(install, { loader: loaderFile });
  ok(platform + ": it patches", done.ok === true, JSON.stringify(done.error));
  const manifest = JSON.parse(fs.readFileSync(install.manifest, "utf8"));
  ok(
    platform + ": the manifest records the loader, the channel and the version",
    manifest.tool === "hypercord" && manifest.loader === loaderFile && manifest.channel === "stable" && (version === null || manifest.version === version),
    JSON.stringify({ tool: manifest.tool, loader: manifest.loader, channel: manifest.channel, version: manifest.version }),
  );
  const entry = fs.readFileSync(path.join(install.appDir, "index.js"), "utf8");
  ok(
    platform + ": the entry point requires that loader and hands off to the real client",
    entry.includes("require(" + JSON.stringify(loaderFile) + ")") && entry.includes('module.exports = require("../hypercord.app.asar")'),
    entry.split("\n")[2],
  );
  ok(platform + ": the install inspects as patched", inspect(install).state === "patched");
  ok(platform + ": and the client's own archive is untouched", fs.readFileSync(path.join(install.resources, "hypercord.app.asar")).equals(bytes));
  const back = unpatch(install);
  ok(platform + ": unpatching restores the directory exactly", back.ok === true && tree(install.resources) === clean, tree(install.resources));
}

const standInResources = (resources) => ({
  channel: "stable",
  channelName: "Discord",
  version: "",
  root: path.dirname(resources),
  resources,
  appAsar: path.join(resources, "app.asar"),
  originalAsar: path.join(resources, "hypercord.app.asar"),
  appDir: path.join(resources, "app"),
  manifest: path.join(resources, "app", "hypercord.json"),
  executable: "",
  appBundle: "",
  launchCommand: { cmd: "discord", args: [] },
  exists: (p) => fs.existsSync(p),
});

roundTrip("linux config", linux.found.ok ? linux.found.install : standInResources(linux.resources), { version: linux.found.ok ? "1.0.136" : null });
roundTrip("linux package", pkg.ok ? pkg.install : standInResources(path.join(pkgRoot, "resources")), { version: pkg.ok ? "" : null });
roundTrip("flatpak", flat.ok ? flat.install : standInResources(flatpakResources), { version: flat.ok ? "" : null });
roundTrip("macos", macBoth.ok ? macBoth.install : standInResources(macResources), { version: macBoth.ok ? "1.2.3" : null });

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

// The two other platforms, started through the same injected spawn: Linux launches the
// binary inside the install, and macOS goes through the Finder with the bundle it was
// given, so what opens is the copy that was patched.
const linuxInstall = linux.found.ok ? linux.found.install : standIn(path.join(root, "Discord"));
const linuxCalls = [];
const startedLinux = launch(linuxInstall, { spawnImpl: (cmd, args) => (linuxCalls.push([cmd, args]), { unref() {} }) });
ok("a linux install is started directly, with no wrapper around it", startedLinux.ok === true && linuxCalls.length === 1 && /(^|[\\/])Discord$/.test(linuxCalls[0][0]), JSON.stringify(linuxCalls));
const macOnce = mac.ok ? mac.install : macInstall;
const macCalls = [];
const startedMac = launch(macOnce, { spawnImpl: (cmd, args) => (macCalls.push([cmd, args]), { unref() {} }) });
ok("a mac install is opened as its own bundle, not by name", startedMac.ok === true && macCalls.length === 1 && macCalls[0][0] === "open" && macCalls[0][1][1] === macOnce.appBundle, JSON.stringify(macCalls));

// The bundle is the thing that can be gone, and `open` would otherwise fall back to
// whichever copy the Finder finds first - so it is refused, and the refusal names the
// bundle rather than the command that is always there.
const goneBundlePath = path.join(root, "nowhere", "Discord.app");
const goneBundle = { ...standIn("open", ["-a", goneBundlePath]), appBundle: goneBundlePath };
const startedGone = launch(goneBundle, { spawnImpl: fakeSpawn });
ok("launching a bundle that is not there is a message, not a throw", startedGone.ok === false && /bundle is not here/.test(startedGone.error), JSON.stringify(startedGone));

/* ---- 4. the loader ------------------------------------------------------ */

const script = loader.buildInjection({ css: ".a { color: red; }" });
ok("the injection writes one style element", (script.match(/hypercord-theme/g) || []).length >= 2 && script.includes("document.createElement('style')"));
// the loader's whole footprint in Discord's page: one stylesheet. A host element, or
// any other node of ours in there, is what the rail used to be and must stay gone.
ok("and nothing else of ours is written into the page", !script.includes("createElement('div')") && !script.includes("hypercord-rail"));
ok("the injection carries the css as data", script.includes(JSON.stringify(".a { color: red; }")));
ok("the injection cannot break out of its own string", !loader.buildInjection({ css: 'x"; alert(1); "' }).includes('x"; alert(1); "'));
ok("the entry source is what the patcher writes", entrySource("/x/loader.cjs").includes('require("/x/loader.cjs")'));

function fakeWindow({ loading = false, url = "https://discord.com/app" } = {}) {
  const executed = [];
  const once = [];
  return {
    id: executed.length + 1,
    webContents: {
      executed,
      isLoading: () => loading,
      getURL: () => url,
      executeJavaScript: (s) => (executed.push(s), Promise.resolve({ ok: true })),
      once: (name, fn) => once.push({ name, fn }),
      fire: (name) => once.filter((h) => h.name === name).forEach((h) => h.fn()),
    },
  };
}

// A window gets two scripts, each exactly once: the stylesheet, and the built plugin
// runtime. They are counted apart, because "one script" stopped being the contract the day
// the runtime was added - and a window that is not on Discord's page gets the stylesheet
// alone, which is the other half of the same contract.
//
// The stylesheet is found by the id only it writes rather than by "creates a style element":
// the runtime's own script creates one too (its own stylesheet, which ships beside its bundle
// and is injected with it - see readRuntime in src/loader.cjs), so counting those would count
// the runtime as a second copy of the theme.
const stylesOf = (win) => win.webContents.executed.filter((s) => String(s).includes(loader.STYLE_ID));
const runtimesOf = (win) => win.webContents.executed.filter((s) => String(s).includes("__hypercordRuntime"));
const bothOnce = (win) => stylesOf(win).length === 1 && runtimesOf(win).length === 1;

const first = fakeWindow();
const app = { BrowserWindow: { getAllWindows: () => [first] }, on: (name, fn) => (app.handlers = { ...(app.handlers || {}), [name]: fn }), handlers: {} };
const fireCreated = (win) => (app.handlers["browser-window-created"] || (() => {}))({}, win);
const res = loader.attach(app, { css: "body{}", log: () => {} });
ok("the loader attaches to a window that is already open", res.ok === true);
await tick();
ok("and injects into it exactly once, the stylesheet and the runtime", bothOnce(first), "executed " + first.webContents.executed.length);

const later = fakeWindow();
fireCreated(later);
await tick();
ok("and into a window created afterwards", bothOnce(later), "executed " + later.webContents.executed.length);

const loading = fakeWindow({ loading: true });
fireCreated(loading);
await tick();
ok("a window still loading is waited for, not injected into", loading.webContents.executed.length === 0);
loading.webContents.fire("did-finish-load");
await tick();
ok("and injected once its page is ready", bothOnce(loading));

fireCreated(later);
await tick();
ok("a window is never injected into twice", bothOnce(later), "executed " + later.webContents.executed.length);

const helper = fakeWindow({ url: "about:blank" });
fireCreated(helper);
await tick();
ok("a window that is not on Discord's page gets the styling and no runtime", stylesOf(helper).length === 1 && runtimesOf(helper).length === 0, JSON.stringify(helper.webContents.executed.map((s) => String(s).slice(0, 18))));

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

/* ---- 3.5 what a patch records about itself ------------------------------ */

// The build that patched an install, the runtime it shipped and the platform it ran on -
// recorded in the manifest, because there is no other place a client running inside Discord
// can read any of it, and a report that says nothing is worse than one that says "not found".
const appRoot = path.join(root, "app-root");
fs.mkdirSync(path.join(appRoot, "vendor", "runtime"), { recursive: true });
fs.mkdirSync(path.join(appRoot, "plugins"), { recursive: true });
const runtimeJs = Buffer.from("// the built runtime bundle\n".repeat(40));
const runtimeCss = Buffer.from("body{color:#fff}\n");
fs.writeFileSync(path.join(appRoot, "vendor", "runtime", "browser.js"), runtimeJs);
fs.writeFileSync(path.join(appRoot, "vendor", "runtime", "browser.css"), runtimeCss);
fs.writeFileSync(
  path.join(appRoot, "plugins", "manifest.json"),
  JSON.stringify({
    generatedAt: "2026-10-13T22:48:14.002Z",
    provenance: { core: "Equicord", coreCommit: "e0e85c8d", merged: "Vencord", mergedCommit: "16ec4ea8" },
  }),
);
// computed here from the fixture's own bytes rather than written down: a hardcoded digest
// would fail the first time the runtime is rebuilt, which is not a bug in the patch
const sha = (buffer) => "sha256:" + crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
const readManifest = (install) => JSON.parse(fs.readFileSync(path.join(install.resources, "app", "hypercord.json"), "utf8"));

const h = makeInstall("h");
const recorded = patch(h.found.install, { loader: loaderFile, version: "9.9.9", appRoot, assets: { css: ".first{}" } });
const hManifest = readManifest(h.found.install);
ok("the patch records which build patched it", recorded.ok === true && hManifest.patchedByVersion === "9.9.9", String(hManifest.patchedByVersion));
ok("and the client's own version stays in `version`", hManifest.version === "1.0.136", String(hManifest.version));
ok(
  "the runtime it shipped is recorded as bytes, not as a version",
  hManifest.runtime.files.length === 2 && hManifest.runtime.files[0].bytes === runtimeJs.length && hManifest.runtime.files[0].sha256 === sha(runtimeJs),
  JSON.stringify(hManifest.runtime.files),
);
ok(
  "and the upstream commits it was built from",
  Boolean(hManifest.runtime.provenance) && hManifest.runtime.provenance.coreCommit === "e0e85c8d" && hManifest.runtime.provenance.merged === "Vencord",
  JSON.stringify(hManifest.runtime.provenance),
);
ok(
  "the platform is recorded too",
  hManifest.platform.os === process.platform && Boolean(hManifest.platform.arch) && hManifest.platform.node === process.versions.node,
  JSON.stringify(hManifest.platform),
);

const againPatch = patch(h.found.install, { loader: loaderFile, version: "9.9.9", appRoot, assets: { css: ".first{}" } });
ok("patching an install this same build already patched is a no-op", againPatch.ok === true && againPatch.already === true && againPatch.reapplied === false, JSON.stringify(againPatch));

// when the build moves on, the record is refreshed in place: the asar rename and the entry
// directory ARE the patch, so a refresh must leave both exactly as they are
const beforeAsar = fs.readFileSync(path.join(h.resources, "hypercord.app.asar"));
const beforeEntry = fs.readFileSync(path.join(h.resources, "app", "index.js"), "utf8");
const refreshed = patch(h.found.install, { loader: loaderFile, version: "9.10.0", appRoot });
const hRefreshed = readManifest(h.found.install);
ok("a newer build refreshes the record in place", refreshed.ok === true && refreshed.reapplied === true && hRefreshed.patchedByVersion === "9.10.0", JSON.stringify(refreshed));
ok("the client's own archive is not touched by a refresh", fs.readFileSync(path.join(h.resources, "hypercord.app.asar")).equals(beforeAsar));
ok("nor is the entry point", fs.readFileSync(path.join(h.resources, "app", "index.js"), "utf8") === beforeEntry);
ok("and a stylesheet a previous patch baked survives a refresh that brings none", hRefreshed.assets.css === ".first{}", JSON.stringify(hRefreshed.assets));
ok("the timestamp of the first patch is kept", hRefreshed.patchedAt === hManifest.patchedAt, hRefreshed.patchedAt + " vs " + hManifest.patchedAt);
ok("and that install still unpaches like any other", unpatch(h.found.install).ok === true);

// a build with no runtime beside it says so rather than recording an empty truth
const i = makeInstall("i");
const barePatch = patch(i.found.install, { loader: loaderFile, version: "9.9.9", appRoot: path.join(root, "no-app-root") });
const bareManifest = readManifest(i.found.install);
ok(
  "a build with no vendor/runtime records that it has none",
  barePatch.ok === true && bareManifest.runtime.files.length === 0 && bareManifest.runtime.note.includes("no vendor/runtime"),
  JSON.stringify(bareManifest.runtime),
);
ok("and provenance it cannot read is null, not invented", bareManifest.runtime.provenance === null, JSON.stringify(bareManifest.runtime.provenance));
ok("that install unpaches like any other", unpatch(i.found.install).ok === true);

// freshness: numbers, never strings. "0.3.9" > "0.3.10" as text, which is the whole point
const fresh = (manifest, version) => patchFreshness(manifest, version);
ok("a build older than this client is reported older", fresh({ patchedByVersion: "0.3.9" }, "0.3.10").state === "older" && fresh({ patchedByVersion: "0.3.9" }, "0.3.10").older === true);
ok("and the comparison is numeric, not textual", fresh({ patchedByVersion: "0.3.10" }, "0.3.9").state === "newer");
ok("the same build is current", fresh({ patchedByVersion: "0.3.10" }, "0.3.10").state === "current");
ok("an install patched before this was recorded is unknown, not stale", fresh({}, "0.3.10").state === "unknown" && fresh({}, "0.3.10").older === false);
ok(
  "a pre-release tag cannot be ordered, and is not called older",
  fresh({ patchedByVersion: "0.4.0-beta.1" }, "0.3.10").state === "unorderable" && fresh({ patchedByVersion: "0.4.0-beta.1" }, "0.3.10").older === false,
  JSON.stringify(fresh({ patchedByVersion: "0.4.0-beta.1" }, "0.3.10")),
);

fs.rmSync(root, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
