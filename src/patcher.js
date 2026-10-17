// language: JavaScript, file: src/patcher.js
//
// Run the REAL Discord client with Hypercord in front of it.
//
// A window of ours showing discord.com is not the client: it is a second client,
// with its own session, its own updater and its own bugs. So when an install is
// present we patch it instead, and the thing the user gets is Discord itself.
//
// The method is the one Discord mod loaders actually use, and it never rewrites
// a binary archive:
//
//   1. `resources/app.asar` is renamed to `resources/hypercord.app.asar` - a
//      byte-for-byte rename, so Discord's own main module is untouched;
//   2. a DIRECTORY `resources/app` is created next to it, holding a package.json
//      and an index.js that requires this loader and then hands off to the
//      renamed archive. Electron prefers `app.asar` over `app`, which is exactly
//      why the original has to be moved out of the way rather than left beside.
//
// Everything is reversible, everything is verified before it is done, and a
// scrape halfway through rolls itself back. Nothing here guesses a version: the
// `app-<version>` directory is discovered, because Discord's updater changes it
// on every release.
import crypto from "node:crypto";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * The filesystem every question about an install goes through.
 *
 * Electron's `fs` is not the filesystem. A path containing `.asar` is answered by opening the
 * archive, and the handle that keeps is opened without delete sharing - so one `existsSync` on
 * `resources/app.asar` leaves the file unrenameable until the process ends, which is exactly the
 * operation a patch is: `app.asar` becomes `hypercord.app.asar`. Measured on Electron 44.7.0
 * (Windows): `disk.existsSync(...app.asar)` and then `disk.renameSync` fails
 * `EBUSY: resource busy or locked`, while the same two calls through `original-fs` both succeed.
 * The symptom was a client that decided the install was clean, refused to patch it, and opened
 * its own window instead - on every run, forever, with the feed and the install both fine.
 *
 * So discovery, inspection and the patch itself read the disk through Electron's own escape
 * hatch - `original-fs`, the module without asar support - and fall back to `node:fs` where there
 * is no such thing (plain Node, which is where the unit suites run).
 */
let disk = nodeFs;
try {
  const original = await import("original-fs");
  const candidate = original && original.default && typeof original.default.existsSync === "function" ? original.default : original;
  if (candidate && typeof candidate.existsSync === "function") disk = candidate;
} catch {
  /* plain Node: `fs` *is* the disk there, and there is no asar support to escape */
}

const ORIGINAL = "hypercord.app.asar";
const APP_DIR = "app";
const MANIFEST = "hypercord.json";

const WINDOWS_CHANNELS = [
  { id: "stable", name: "Discord", dir: "Discord", exe: "Discord.exe" },
  { id: "ptb", name: "Discord PTB", dir: "DiscordPTB", exe: "DiscordPTB.exe" },
  { id: "canary", name: "Discord Canary", dir: "DiscordCanary", exe: "DiscordCanary.exe" },
];

const MAC_BUNDLES = [
  { id: "stable", name: "Discord", bundle: "Discord.app" },
  { id: "ptb", name: "Discord PTB", bundle: "Discord PTB.app" },
  { id: "canary", name: "Discord Canary", bundle: "Discord Canary.app" },
];

const LINUX_CONFIG_CHANNELS = [
  { id: "stable", name: "Discord", dir: "discord", binary: "discord" },
  { id: "ptb", name: "Discord PTB", dir: "discordptb", binary: "discord-ptb" },
  { id: "canary", name: "Discord Canary", dir: "discordcanary", binary: "discord-canary" },
];

const LINUX_PACKAGE_ROOTS = ["/usr/share/discord", "/opt/Discord", "/usr/lib/discord", "/usr/lib64/discord"];

const FLATPAK_APPS = [
  { id: "stable", name: "Discord", appId: "com.discordapp.Discord", inner: ["discord", "Discord"] },
  { id: "ptb", name: "Discord PTB", appId: "com.discordapp.DiscordPTB", inner: ["discord-ptb", "DiscordPTB"] },
  { id: "canary", name: "Discord Canary", appId: "com.discordapp.DiscordCanary", inner: ["discord-canary", "DiscordCanary"] },
];

const CHANNEL_ORDER = { stable: 0, ptb: 1, canary: 2 };

/* ---- small, injectable filesystem helpers -------------------------------- */

function defaultExists(file) {
  try {
    return disk.existsSync(file);
  } catch {
    return false;
  }
}

function defaultReaddir(dir) {
  try {
    return disk.readdirSync(dir);
  } catch {
    return [];
  }
}

function defaultReadFile(file) {
  try {
    return disk.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function compareVersions(a, b) {
  const left = String(a || "0").split(".").map((n) => Number(n) || 0);
  const right = String(b || "0").split(".").map((n) => Number(n) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * A short, labelled digest of a file - the identity of the bytes, for a report.
 *
 * Truncated on purpose, and labelled with its algorithm so nobody mistakes sixteen hex
 * characters for something to compare against a published artifact. A file that cannot
 * be read answers null rather than a digest of nothing.
 */
function digest(file) {
  try {
    return "sha256:" + crypto.createHash("sha256").update(disk.readFileSync(file)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Which vendored runtime this build ships, as facts rather than a version string.
 *
 * There is no version number for the runtime anywhere in the tree: `vendor/runtime/` is
 * `browser.js` and `browser.css`, and the only provenance that exists is the generated
 * `plugins/manifest.json`. So the identity recorded here is the bytes themselves (size
 * and a truncated digest) plus the two upstream commits that produced them, and a build
 * with no runtime beside it records *that*, with the reason - a report that says nothing
 * is worse than one that says "not found".
 */
export function runtimeFacts(appRoot, { exists = defaultExists } = {}) {
  const root = String(appRoot || "");
  const files = [];
  for (const name of ["browser.js", "browser.css"]) {
    const file = path.join(root, "vendor", "runtime", name);
    if (!exists(file)) continue;
    let bytes = 0;
    try {
      bytes = disk.statSync(file).size;
    } catch {
      bytes = 0;
    }
    files.push({ name: "vendor/runtime/" + name, bytes, sha256: digest(file) });
  }
  let provenance = null;
  try {
    const generated = JSON.parse(disk.readFileSync(path.join(root, "plugins", "manifest.json"), "utf8")) || {};
    const upstream = generated.provenance && typeof generated.provenance === "object" ? generated.provenance : null;
    if (upstream) {
      provenance = {
        generatedAt: String(generated.generatedAt || ""),
        core: String(upstream.core || ""),
        coreCommit: String(upstream.coreCommit || ""),
        merged: String(upstream.merged || ""),
        mergedCommit: String(upstream.mergedCommit || ""),
      };
    }
  } catch {
    provenance = null;
  }
  return {
    files,
    provenance,
    note: files.length ? "" : "this build has no vendor/runtime, so the runtime it ships is not recorded",
  };
}

/**
 * The platform this build runs on. Defaults come from the process and every one of them
 * can be injected, the same way the updater takes `platform` and `env` - a test has to be
 * able to put this build anywhere.
 */
export function platformFacts(opts = {}) {
  const versions = opts.versions && typeof opts.versions === "object" ? opts.versions : process.versions;
  return {
    os: String(opts.platform || process.platform),
    arch: String(opts.arch || process.arch),
    release: String(opts.osRelease || os.release()),
    type: String(opts.osType || os.type()),
    electron: String((versions && versions.electron) || ""),
    chrome: String((versions && versions.chrome) || ""),
    node: String((versions && versions.node) || ""),
  };
}

/**
 * The manifest a patch writes: what it did, who did it, and what it shipped.
 *
 * `version` is deliberately Discord's own and stays that way - it is the version of the
 * client that was patched. The build that *did* the patching is `patchedByVersion`, named
 * that way because a reader who confuses the two would compare Discord's number against
 * Hypercord's and conclude nonsense.
 *
 * Baked assets are preserved when the caller supplies none: refreshing a patch must never
 * blank a stylesheet that a previous patch put there, which is a real way to break a
 * client that looked fine a second earlier.
 */
export function patchManifest({ install, loader, assets, opts = {} }) {
  const root = opts.appRoot !== undefined ? String(opts.appRoot) : path.join(path.dirname(loader), "..");
  const previous = opts.previous && typeof opts.previous === "object" ? opts.previous : {};
  const baked = assets && Object.keys(assets).length ? assets : previous.assets && typeof previous.assets === "object" ? previous.assets : {};
  return {
    tool: "hypercord",
    loader,
    original: ORIGINAL,
    appAsar: install.appAsar,
    channel: install.channel,
    version: install.version,
    patchedByVersion: String(opts.version || ""),
    patchedAt: String(previous.patchedAt || "") || new Date().toISOString(),
    runtime: runtimeFacts(root, opts),
    platform: platformFacts(opts),
    assets: baked,
  };
}

/**
 * Is the build recorded in a manifest older than the build asking?
 *
 * Numbers, never strings: as text "0.3.9" is greater than "0.3.10", which is the whole
 * reason this goes through compareVersions. A version that is not a plain dotted number - a
 * pre-release tag, a development string, nothing at all - cannot be ordered, and the answer
 * says so rather than guessing: a wrong "older" in a warning is worse than no warning.
 */
export function patchFreshness(manifest, runningVersion) {
  const recorded = String((manifest && manifest.patchedByVersion) || "");
  const running = String(runningVersion || "");
  const plain = /^\d+(\.\d+)*$/;
  if (!recorded) {
    return { state: "unknown", recorded, running, older: false, reason: "the build that patched this install was not recorded (it was patched before this was recorded)" };
  }
  if (!running) return { state: "unknown", recorded, running, older: false, reason: "this run does not know its own version" };
  if (!plain.test(recorded) || !plain.test(running)) {
    return { state: "unorderable", recorded, running, older: false, reason: "the recorded build " + recorded + " and this build " + running + " cannot be ordered" };
  }
  const order = compareVersions(recorded, running);
  if (order < 0) return { state: "older", recorded, running, older: true, reason: "patched by " + recorded + " and this client is " + running };
  if (order > 0) return { state: "newer", recorded, running, older: false, reason: "patched by " + recorded + ", which is newer than this client (" + running + ")" };
  return { state: "current", recorded, running, older: false, reason: "" };
}

/** The `app-<version>` directories inside an install root, newest first. */
function versionsIn(base, { exists, readdir }) {
  return readdir(base)
    .filter((name) => /^app-/.test(name))
    .map((name) => ({ name, version: name.replace(/^app-/, "") }))
    .filter((entry) => exists(path.join(base, entry.name, "resources")))
    .map((entry) => entry.version)
    .sort((a, b) => compareVersions(b, a));
}

function looksLikeInstall(resources, exists) {
  return exists(path.join(resources, "app.asar")) || exists(path.join(resources, ORIGINAL));
}

function makeInstall({ channel, channelName, version, root, resources, executable, appBundle = "", launchCommand, exists }) {
  const install = {
    channel,
    channelName,
    version: String(version || ""),
    root,
    resources,
    appAsar: path.join(resources, "app.asar"),
    originalAsar: path.join(resources, ORIGINAL),
    appDir: path.join(resources, APP_DIR),
    manifest: path.join(resources, APP_DIR, MANIFEST),
    executable: executable || "",
    appBundle,
    launchCommand,
    exists,
  };
  install.launch = (opts = {}) => launch(install, opts);
  return install;
}

/* ---- discovery ----------------------------------------------------------- */

/**
 * Every Discord install we can find, best first: stable before PTB before
 * Canary, and within a channel the newest version. Everything that touches the
 * filesystem is injectable so a test can point this at a temp directory instead
 * of somebody's real install.
 */
export function listInstalls(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const exists = opts.exists || defaultExists;
  const readdir = opts.readdir || defaultReaddir;
  const readFile = opts.readFile || defaultReadFile;
  const out = [];

  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    for (const channel of WINDOWS_CHANNELS) {
      const base = path.join(local, channel.dir);
      for (const version of versionsIn(base, { exists, readdir })) {
        const root = path.join(base, "app-" + version);
        const resources = path.join(root, "resources");
        out.push(
          makeInstall({
            channel: channel.id,
            channelName: channel.name,
            version,
            root,
            resources,
            executable: path.join(root, channel.exe),
            launchCommand: { cmd: path.join(root, channel.exe), args: [] },
            exists,
          }),
        );
      }
    }
  } else if (platform === "darwin") {
    const bases = Array.isArray(opts.appBases) ? opts.appBases : ["/Applications", path.join(home, "Applications")];
    for (const base of bases) {
      for (const channel of MAC_BUNDLES) {
        const bundle = path.join(base, channel.bundle);
        const resources = path.join(bundle, "Contents", "Resources");
        if (!looksLikeInstall(resources, exists)) continue;
        const plist = readFile(path.join(bundle, "Contents", "Info.plist"));
        const version = (/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist) || [])[1] || "";
        out.push(
          makeInstall({
            channel: channel.id,
            channelName: channel.name,
            version,
            root: bundle,
            resources,
            executable: bundle,
            appBundle: bundle,
            // a bundle is started by asking the Finder to open it
            launchCommand: { cmd: "open", args: ["-a", bundle] },
            exists,
          }),
        );
      }
    }
  } else {
    const config = env.XDG_CONFIG_HOME || path.join(home, ".config");
    for (const channel of LINUX_CONFIG_CHANNELS) {
      const base = path.join(config, channel.dir);
      for (const version of versionsIn(base, { exists, readdir })) {
        const root = path.join(base, "app-" + version);
        const resources = path.join(root, "resources");
        const binary = exists(path.join(root, "Discord")) ? path.join(root, "Discord") : channel.binary;
        out.push(
          makeInstall({
            channel: channel.id,
            channelName: channel.name,
            version,
            root,
            resources,
            executable: binary,
            launchCommand: { cmd: binary, args: [] },
            exists,
          }),
        );
      }
    }
    const packageRoots = Array.isArray(opts.packageRoots) ? opts.packageRoots : LINUX_PACKAGE_ROOTS;
    for (const root of packageRoots) {
      const resources = path.join(root, "resources");
      if (!looksLikeInstall(resources, exists)) continue;
      const id = /canary/i.test(root) ? "canary" : /ptb/i.test(root) ? "ptb" : "stable";
      const channel = LINUX_CONFIG_CHANNELS.find((c) => c.id === id) || LINUX_CONFIG_CHANNELS[0];
      // The binary inside the root when it is there, which is the rule the
      // config-directory branch above already follows: a bare name is resolved through
      // PATH, and a machine with more than one Discord would then start a different copy
      // than the one that was just patched.
      const binary = exists(path.join(root, "Discord")) ? path.join(root, "Discord") : channel.binary;
      out.push(
        makeInstall({
          channel: id,
          channelName: channel.name,
          version: "",
          root,
          resources,
          executable: binary,
          launchCommand: { cmd: binary, args: [] },
          exists,
        }),
      );
    }
    const flatpakParents = Array.isArray(opts.flatpakFiles)
      ? opts.flatpakFiles
      : [
          "/var/lib/flatpak/app",
          path.join(home, ".local", "share", "flatpak", "app"),
        ];
    for (const channel of FLATPAK_APPS) {
      const deployments = flatpakParents.map((parent) => path.join(parent, channel.appId, "current", "active", "files"));
      for (const files of deployments) {
        // the documented inner name first, then whatever is actually in there,
        // because Flatpak deployments differ between distros
        const candidates = [...channel.inner.map((inner) => path.join(files, inner)), ...readdir(files).map((inner) => path.join(files, inner))];
        for (const candidate of candidates) {
          const resources = path.join(candidate, "resources");
          if (!looksLikeInstall(resources, exists)) continue;
          out.push(
            makeInstall({
              channel: channel.id,
              channelName: channel.name,
              version: "",
              root: candidate,
              resources,
              executable: "",
              launchCommand: { cmd: "flatpak", args: ["run", channel.appId] },
              exists,
            }),
          );
          break;
        }
      }
    }
  }

  return out
    .filter((install) => looksLikeInstall(install.resources, exists))
    .sort((a, b) => (CHANNEL_ORDER[a.channel] - CHANNEL_ORDER[b.channel]) || compareVersions(b.version, a.version));
}

/** The install to use, or a reason there is none. */
export function findDiscord(opts = {}) {
  const installs = listInstalls(opts);
  if (!installs.length) {
    return { ok: false, error: "no Discord install found", installs: [] };
  }
  return { ok: true, install: installs[0], installs };
}

/* ---- what state an install is in ----------------------------------------- */

function readManifest(install, readFile) {
  try {
    return JSON.parse(readFile(install.manifest)) || null;
  } catch {
    return null;
  }
}

/**
 * clean      - Discord's own app.asar, nothing of ours
 * patched    - our resources/app is in place (ours, and only ours)
 * half       - the original was moved aside but the entry directory is gone
 * foreign    - somebody else's resources/app is there: hands off
 * missing    - there is no app.asar to patch at all
 */
export function inspect(install, opts = {}) {
  const readFile = opts.readFile || defaultReadFile;
  if (!install.exists(install.resources)) {
    return { state: "missing", ok: false, error: "no resources directory at " + install.resources };
  }
  const hasAsar = install.exists(install.appAsar);
  const hasOriginal = install.exists(install.originalAsar);
  if (install.exists(install.appDir)) {
    const manifest = readManifest(install, readFile);
    if (manifest && manifest.tool === "hypercord") return { state: "patched", ok: true, manifest };
    return { state: "foreign", ok: false, error: "resources/app already exists and is not Hypercord's: " + install.appDir };
  }
  if (!hasAsar && hasOriginal) return { state: "half", ok: true };
  if (!hasAsar && !hasOriginal) return { state: "missing", ok: false, error: "no app.asar at " + install.appAsar };
  return { state: "clean", ok: true };
}

/* ---- patch and unpatch --------------------------------------------------- */

/**
 * hypercord.json sitting beside the loader, baked in at patch time when the caller
 * did not hand over assets itself. That is what makes a patched install show
 * something: the loader reads what the patch recorded, so no second file has to be
 * found later and no launch-time environment has to be arranged.
 *
 * The stylesheet is the whole payload - the rail markup that used to travel with
 * it is gone - and the file may carry it either on its own or inside an `assets`
 * object, which is the shape the patch itself writes.
 */
function readBakedAssets(loader) {
  for (const file of [path.join(path.dirname(loader), "hypercord.json"), path.join(path.dirname(loader), "..", "hypercord.json")]) {
    let found = null;
    try {
      found = JSON.parse(disk.readFileSync(file, "utf8")) || null;
    } catch {
      found = null;
    }
    const assets = found && found.assets && typeof found.assets === "object" ? found.assets : found;
    if (assets && assets.css) return { css: String(assets.css), from: file };
  }
  return {};
}

/** The entry point Discord will run instead of its own: load us, then hand off. */
export function entrySource(loader) {
  return [
    "// Hypercord's entry point for the Discord client. Written by src/patcher.js.",
    "// If the loader cannot start, Discord still has to start: hence the try/catch.",
    "try {",
    "  require(" + JSON.stringify(String(loader)) + ");",
    "} catch (err) {",
    '  console.error("[Hypercord] the loader did not start: " + ((err && err.stack) || err));',
    "}",
    'module.exports = require("../' + ORIGINAL + '");',
    "",
  ].join("\n");
}

export function patch(install, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const loader = opts.loader ? String(opts.loader) : "";
  const assets = opts.assets && typeof opts.assets === "object" && Object.keys(opts.assets).length ? opts.assets : readBakedAssets(loader);
  const state = inspect(install, opts);
  if (state.state === "foreign" || state.state === "missing") return { ok: false, state: state.state, error: state.error };
  if (state.state === "patched") {
    // Patched is not the same as *right*. The manifest records which build patched this
    // install, what runtime it shipped and what stylesheet it baked - and a client that has
    // updated itself since is new code beside an old record and an old stylesheet. So the
    // patched case refreshes the record in place when anything it holds has moved; the asar
    // rename and the entry directory are left exactly as they are, because replacing those
    // is unpatching and patching again, not refreshing.
    const previous = state.manifest && typeof state.manifest === "object" ? state.manifest : {};
    const next = patchManifest({ install, loader, assets, opts: { ...opts, previous } });
    const bakedBefore = previous.assets && typeof previous.assets === "object" ? String(previous.assets.css || "") : "";
    const bakedNow = next.assets && typeof next.assets === "object" ? String(next.assets.css || "") : "";
    const wanted = assets && assets.css !== undefined ? String(assets.css || "") : bakedBefore;
    const changed =
      String(previous.patchedByVersion || "") !== next.patchedByVersion ||
      !previous.runtime ||
      !previous.platform ||
      JSON.stringify(previous.runtime) !== JSON.stringify(next.runtime) ||
      JSON.stringify(previous.platform) !== JSON.stringify(next.platform) ||
      bakedNow !== wanted;
    if (!changed || opts.dryRun) return { ok: true, already: true, state: "patched", reapplied: false, steps: [] };
    try {
      disk.writeFileSync(install.manifest, JSON.stringify(next, null, 1) + "\n");
    } catch (err) {
      return { ok: false, state: "patched", error: "the patch record could not be refreshed: " + String((err && err.message) || err) };
    }
    log("[hypercord] patch: refreshed the record in place (patched by " + (next.patchedByVersion || "an unrecorded build") + ")");
    return { ok: true, already: true, state: "patched", reapplied: true, steps: ["refresh " + MANIFEST] };
  }
  if (!loader) return { ok: false, error: "a loader path is required to patch a client" };
  if (!install.exists(loader)) return { ok: false, error: "the loader is not here: " + loader };

  const indexPath = path.join(install.appDir, "index.js");
  const packagePath = path.join(install.appDir, "package.json");
  const steps = [];
  const add = (describe, run, undo) => steps.push({ describe, run, undo });

  if (state.state === "clean") {
    add(
      "move app.asar aside as " + ORIGINAL,
      () => disk.renameSync(install.appAsar, install.originalAsar),
      () => disk.renameSync(install.originalAsar, install.appAsar),
    );
  }
  add("create " + install.appDir, () => disk.mkdirSync(install.appDir, { recursive: true }), () => disk.rmSync(install.appDir, { recursive: true, force: true }));
  add(
    "write package.json",
    () => disk.writeFileSync(packagePath, JSON.stringify({ name: "hypercord-loader", version: "1.0.0", private: true, main: "index.js" }, null, 1) + "\n"),
    () => disk.rmSync(packagePath, { force: true }),
  );
  add("write index.js", () => disk.writeFileSync(indexPath, entrySource(loader)), () => disk.rmSync(indexPath, { force: true }));
  add(
    "write " + MANIFEST,
    () => disk.writeFileSync(install.manifest, JSON.stringify(patchManifest({ install, loader, assets, opts }), null, 1) + "\n"),
    () => disk.rmSync(install.manifest, { force: true }),
  );

  if (opts.dryRun) return { ok: true, dryRun: true, state: state.state, steps: steps.map((s) => s.describe) };

  const done = [];
  try {
    for (const step of steps) {
      step.run();
      done.push(step);
        log("[hypercord] patch: " + step.describe);
    }
  } catch (err) {
    // put it back exactly as it was: a half-patched client is worse than none
    for (const step of done.reverse()) {
      try {
        step.undo();
      } catch {
        /* the rollback reports itself through the error below */
      }
    }
    return { ok: false, state: "clean", error: "the patch failed and was rolled back: " + String((err && err.message) || err) };
  }
  return { ok: true, state: "patched", steps: steps.map((s) => s.describe) };
}

export function unpatch(install, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const state = inspect(install, opts);
  if (state.state === "clean" || state.state === "missing") return { ok: true, already: true, state: state.state };
  if (state.state === "foreign") return { ok: false, state: "foreign", error: state.error };

  // only our own files, and only the ones the manifest claims: anything else in
  // that directory belongs to somebody else and stays exactly where it is
  const ours = [install.manifest, path.join(install.appDir, "index.js"), path.join(install.appDir, "package.json")];
  if (state.state === "patched") {
    for (const file of ours) {
      try {
        disk.rmSync(file, { force: true });
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
    try {
      const rest = disk.readdirSync(install.appDir);
      if (!rest.length) disk.rmdirSync(install.appDir);
      else log("[hypercord] unpatch: " + install.appDir + " still holds " + rest.length + " file(s) that are not ours");
    } catch {
      /* it is already gone */
    }
  }
  if (!install.exists(install.appAsar) && install.exists(install.originalAsar)) {
    try {
      disk.renameSync(install.originalAsar, install.appAsar);
      log("[hypercord] unpatch: restored app.asar");
    } catch (err) {
      return { ok: false, error: "could not restore app.asar: " + String((err && err.message) || err) };
    }
  }
  return { ok: true, state: "clean" };
}

/* ---- starting the real client -------------------------------------------- */

/** Start Discord itself. A missing binary is a message, never a throw. */
export function launch(install, opts = {}) {
  const spawnImpl = opts.spawnImpl || spawn;
  const command = install.launchCommand || { cmd: "", args: [] };
  if (!command.cmd) return { ok: false, error: "this install has nothing to start" };
  // Absolute paths are checked against the real filesystem, not against
  // whatever `exists` discovery was handed: a run that was told about fake
  // installs must still never try to start a binary that is not there. A bare
  // command name is the shell's PATH to resolve, and a refusal there comes back
  // as a spawn error.
  const present = opts.exists || defaultExists;
  if (path.isAbsolute(command.cmd) && !present(command.cmd)) {
    return { ok: false, error: "the Discord executable is not here: " + command.cmd };
  }
  // A macOS install is started by asking the Finder to open the bundle, so `open` is
  // the command and the bundle travels as an argument: the command always exists and
  // the thing that can be missing is the bundle. Started anyway, `open` resolves the
  // name and can bring up a different copy of Discord than the one that was patched,
  // so the bundle is checked the same way an absolute command is.
  if (install.appBundle && !present(install.appBundle)) {
    return { ok: false, error: "the Discord bundle is not here: " + install.appBundle };
  }
  try {
    const child = spawnImpl(command.cmd, command.args || [], { detached: true, stdio: "ignore", env: { ...process.env, ...(opts.env || {}) } });
    if (child && typeof child.unref === "function") child.unref();
    // The handle travels with the answer, because the one who started Discord is the one who
    // can hear it stop - and Discord applies a staged update as it goes down, which is the
    // moment a *new* `app-<version>` becomes the one a shortcut will start. It is deliberately
    // not waited on: the process is detached and unref'd, so this is an observer, not a parent.
    return { ok: true, command: command.cmd, args: command.args || [], child: child || null };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
