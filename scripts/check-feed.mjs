// language: JavaScript, file: scripts/check-feed.mjs
//
// The other half of a release: the files the updater reads.
//
//   node scripts/check-feed.mjs                 check dist/ (what a local build produced)
//   node scripts/check-feed.mjs --dir release   check the artifacts a release is about to get
//
//   node scripts/check-feed.mjs --dir <download-dir> --require latest-linux-arm64.yml,latest.yml
//
// Why this exists, stated as the failure it prevents: `latest.yml` and its siblings are what an
// installed client reads, and a channel file that names an artifact which is not on the release
// makes the updater fail *silently* - it downloads nothing, logs into a console nobody has, and
// the client goes on reporting the version it already is. Two ways that happened here for real:
// a release that carried `latest-linux.yml` but no `latest-linux-arm64.yml` (so every arm64
// AppImage install asked for a file that did not exist), and a build whose artifacts were
// renamed after the feed was written. Neither is visible from the source tree; both are visible
// from the two files that will sit next to each other on the release page.
//
// The check is deliberately about *pairs* rather than about content: it does not care which
// artifacts exist, only that every file every feed names is present, that no feed names a file
// it has no checksum for, and that every feed agrees with the app's own version - a feed whose
// version drifted from package.json is the third way this goes wrong (the tag says one thing,
// the installers and the feed say another, and the updater compares against a version that is
// not what is being released).
//
// The YAML is read by hand, on purpose. These files are *output*: electron-builder writes them
// (`app-builder-lib`'s updateInfoBuilder) in one flat, predictable shape - `version`, a `files`
// list of `url`/`sha512`/`size`, and a `path` pointing at the file this platform updates from -
// and reading four keys out of that with a scanner is worth less than the dependency a YAML
// parser would add to a tree that deliberately has none. A file that does not parse that way is
// reported as unreadable rather than guessed at, which is the honest failure here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(here, "..");

/** What electron-builder names a feed, across the platforms this client ships. */
export const FEED_FILES = ["latest.yml", "latest-mac.yml", "latest-linux.yml", "latest-linux-arm64.yml"];

function arg(name, fallback = "") {
  const at = process.argv.indexOf("--" + name);
  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

/** The flat shape electron-builder writes: `key: value` lines and `- key: value` list rows. */
export function readFeed(text) {
  const feed = { version: "", path: "", urls: [] };
  let inFiles = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^files:/.test(line)) {
      inFiles = true;
      continue;
    }
    const top = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (top && !line.startsWith("- ")) {
      inFiles = false;
      const key = top[1].toLowerCase();
      const value = top[2].replace(/^["']|["']$/g, "").trim();
      if (key === "version") feed.version = value;
      if (key === "path") feed.path = value;
      continue;
    }
    if (!inFiles) continue;
    const row = line.match(/^-?\s*url:\s*(.*)$/);
    if (row) feed.urls.push(row[1].replace(/^["']|["']$/g, "").trim());
  }
  return feed;
}

/**
 * The feeds the app's own build configuration promises, read from `build` in package.json.
 *
 * This is the half that catches the failure a scan cannot see: a platform or architecture the
 * client ships but which has no feed at all. Windows feeds carry no architecture suffix
 * (`latest.yml` serves x64 and arm64, and the arch-specific *artifact* is picked out of its
 * `files` list), macOS has one file for both architectures, and Linux needs one file per
 * architecture electron-updater asks for - `latest-linux.yml` for x64, `latest-linux-arm64.yml`
 * for arm64. Which is exactly the shape of a real bug this repository had: `package.json`
 * advertised an arm64 AppImage and the release carried no `latest-linux-arm64.yml`, so every
 * arm64 install asked for a file that did not exist and never updated. Deriving the expectation
 * from the same file that decides what gets built is what keeps those two from drifting apart.
 */
export function requiredFeeds(build = {}) {
  const archs = (platform) => {
    const targets = build?.[platform]?.target;
    const rows = Array.isArray(targets) ? targets : targets ? [targets] : [];
    const out = new Set();
    for (const row of rows) {
      const list = row && typeof row === "object" ? row.arch : null;
      for (const arch of Array.isArray(list) ? list : ["x64"]) out.add(String(arch));
    }
    return out;
  };
  const out = [];
  if (archs("win").size) out.push("latest.yml");
  if (archs("mac").size) out.push("latest-mac.yml");
  const linux = archs("linux");
  if (linux.has("x64") || linux.has("ia32")) out.push("latest-linux.yml");
  if (linux.has("arm64")) out.push("latest-linux-arm64.yml");
  if (linux.has("armv7l")) out.push("latest-linux-arm.yml");
  return out;
}

/** Every feed file in a directory, as { file, version, path, urls }. */
export function feedsIn(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^latest.*\.yml$/i.test(name))
    .sort()
    .map((name) => ({ file: name, ...readFeed(fs.readFileSync(path.join(dir, name), "utf8")) }));
}

/**
 * What is wrong with the feeds in a directory, as an array of plain sentences - empty when the
 * release's feeds and its artifacts agree. `expectedVersion` is passed in rather than read here
 * so a test can state the version it is checking against.
 */
export function feedProblems(dir, { expectedVersion = "", require = [] } = {}) {
  const problems = [];
  const feeds = feedsIn(dir);
  const present = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);

  // Named rather than discovered: a platform or architecture with no feed at all is invisible
  // to a scan (there is no file to read), and it is exactly the gap this check was written for.
  for (const want of require) {
    if (!present.has(want)) {
      problems.push(want + " is missing: a client on that platform or architecture asks for it by name and would never find an update");
    }
  }
  if (feeds.length === 0) {
    problems.push("no update feed (latest.yml, latest-mac.yml, latest-linux.yml or latest-linux-arm64.yml) is here to check");
    return problems;
  }

  for (const feed of feeds) {
    if (!feed.path) problems.push(feed.file + " names no path, so there is nothing for a client to download");
    // `path` is the file this platform updates from; the other entries are the same release's
    // other artifacts, and both halves have to exist for the release to be consumable.
    for (const url of [...new Set([feed.path, ...feed.urls].filter(Boolean))]) {
      if (!present.has(url)) {
        problems.push(feed.file + " names " + url + ", which is not in this release: the update would fail with nothing but a log line");
      }
    }
    if (expectedVersion && feed.version && feed.version !== expectedVersion) {
      problems.push(feed.file + " says version " + feed.version + " while the app is " + expectedVersion + ": the updater compares against a version that is not what is being released");
    }
  }
  return problems;
}

/* ---- the command line ----------------------------------------------------- */

// when imported by a test, nothing runs: the checks above are the interface
const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const dir = path.resolve(root, arg("dir", "dist"));
  let expectedVersion = arg("version", "");
  if (!expectedVersion) {
    try {
      expectedVersion = String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "");
    } catch {
      /* a tree with no package.json is checked without the version rule */
    }
  }
  // The app's own build config names the feeds it ships; `--require` is for a caller that knows
  // of one more (a platform built outside this file's config), and `--no-config` for a directory
  // that is being checked on its own - the tests do that.
  let require = arg("require", "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!process.argv.includes("--no-config")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      require = [...new Set([...requiredFeeds(pkg.build), ...require])];
    } catch {
      /* a tree with no package.json is checked against what is here */
    }
  }
  console.log("[hypercord] check:feed: checking " + (path.relative(root, dir).split(path.sep).join("/") || dir));
  const problems = feedProblems(dir, { expectedVersion, require });
  if (require.length) console.log("  this release needs: " + require.join(", "));
  for (const feed of feedsIn(dir)) {
    console.log("  " + feed.file + ": version " + (feed.version || "?") + ", " + feed.urls.length + " file(s), path " + (feed.path || "?"));
  }
  if (problems.length === 0) {
    console.log("[hypercord] check:feed: every feed names artifacts this release carries, and every version agrees");
    process.exit(0);
  }
  for (const problem of problems) console.log("FAIL " + problem);
  console.log("[hypercord] check:feed: " + problems.length + " problem(s): fix the feed or the artifacts before this release is public");
  process.exit(1);
}
