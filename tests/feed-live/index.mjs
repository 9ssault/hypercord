// language: JavaScript, file: tests/feed-live/index.mjs
//
// The update loop, end to end, on a *packed build* - the one suite that drives the artifact
// rather than the source.
//
//   npm run pack  &&  npx electron tests/feed-live     # or: npm run test:feed-live
//   npx electron tests/feed-live --exe "dist/win-unpacked/Hypercord.exe"
//   npx electron tests/feed-live --dist dist
//
// Why it exists: `tests/updater` proves the module's logic against stubs, and it passed while
// the client still could not update itself - because the loop it never touched is the part that
// is not logic. A real packed app was started against a real feed and the download died on
// `ENOENT ... resources/app-update.yml`: electron-updater reads a *config* file for its cache
// directory whatever feed it was given, so every build that shipped none found the update and
// then failed to take it. Nothing in `tests/updater` could see that; this suite sees it, because
// it drives the same two things a user does - the installed binary, and a feed holding a version
// it does not have.
//
// What it does, in order: finds this platform's packed build, generates that platform's own
// channel file from the one the build produced (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`,
// per architecture on Linux - the names are electron-updater's, not ours), serves it from a local
// HTTP server together with the artifacts the feed names, starts the client with
// `HYPERCORD_UPDATE_FEED` pointed at that server, and then reads the client's **own** update state
// (`window.hypercord.update.state()`, the same call the settings page makes) until it reports the
// download or refuses. The app's stdout is printed for diagnosis and never asserted on: a GUI
// build's console output is not a contract, and the state is.
//
// Three platform shapes, because a check that lies about one of them is worse than no check:
//
//   * Windows and macOS: the whole loop - the offer is seen and the artifact is downloaded. On an
//     *unsigned* macOS build Gatekeeper refuses to install, and the download step can say so; that
//     named refusal is accepted here and reported, because it is the true answer for a build with
//     no certificate, and the run must not pretend otherwise.
//   * Linux without `APPIMAGE`: the client refuses to check at all (`mode: "elsewhere"`, the
//     reason naming the AppImage) *and* the feed server is asserted to have seen no request - a
//     deb or a tar.gz install has nothing for an update to replace, which is exactly what that
//     mode is for. Set `APPIMAGE` to the AppImage this build produced to drive the real loop
//     instead: the updater is inactive without it, by electron-updater's own design.
//
// What it never does is install: the client is killed the moment the download is reported
// (`taskkill /T /F` on Windows, the process group elsewhere), because a graceful quit would run
// the installer and change the machine this runs on. The fake offer does leave a file in the
// app's own updater cache (`%LOCALAPPDATA%/hypercord-updater` on Windows and the equivalent
// elsewhere) - one the next real check would have replaced anyway - and it never touches an
// installed copy of the client.
//
// Without a packed build, or without the channel file that build wrote, there is nothing to
// drive. That is reported as `SKIPPED` with the reason and the command that fixes it, and the
// suite exits 0: a runner that has not built anything yet is not a failure, and a silent pass
// would be.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function arg(name, fallback = "") {
  const at = process.argv.indexOf("--" + name);
  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line) => console.log("note  " + line);

// a hang must report itself rather than sit there being a hang
const watchdog = setTimeout(() => {
  console.log("FAIL the suite hung: " + passed + " passed before it stopped");
  app.exit(2);
}, 300000);
watchdog.unref?.();

/** The packed build to drive, wherever electron-builder put it. */
function findExe() {
  const named = arg("exe", "");
  if (named) {
    const full = path.isAbsolute(named) ? named : path.join(root, named);
    return fs.existsSync(full) ? full : "";
  }
  const candidates = [
    "dist/win-unpacked/Hypercord.exe",
    "dist/mac/Hypercord.app/Contents/MacOS/Hypercord",
    "dist/mac-arm64/Hypercord.app/Contents/MacOS/Hypercord",
    "dist/linux-unpacked/hypercord",
    "dist/linux-unpacked/Hypercord",
  ].map((rel) => path.join(root, rel));
  return candidates.find((file) => fs.existsSync(file)) || "";
}

/**
 * This platform's channel file, named the way electron-updater asks for it
 * (`Provider.getChannelFilePrefix`): Windows has no suffix, macOS `-mac`, and Linux carries the
 * architecture - `latest-linux.yml` on x64, `latest-linux-arm64.yml` on arm64. A release that is
 * missing one of those is a whole architecture that never updates, silently, which is why the
 * name is derived here rather than guessed from whatever is in `dist/`.
 */
function feedFileName() {
  if (process.platform === "darwin") return "latest-mac.yml";
  if (process.platform === "linux") {
    const arch = process.env.TEST_UPDATER_ARCH || process.arch;
    return "latest-linux" + (arch === "x64" ? "" : "-" + arch) + ".yml";
  }
  return "latest.yml";
}

/**
 * The offer: this platform's own feed, one patch above the newest version in play, naming a real
 * artifact.
 *
 * "Newest in play" and not "the feed's version", because `dist/` is not built as one set here:
 * the channel file is written by the *installers* step and the unpacked app by `pack`, so a tree
 * that was packed after a version bump carries a client newer than its own `latest.yml`. An offer
 * equal to the running app is one electron-updater ignores *by design* (`isUpdateAvailable` is a
 * strict compare), and the run would then report a stall instead of the loop it exists to prove.
 * Taking the higher of the two - the channel file and the tree's own package.json, which is what
 * the unpacked app was packed from - makes the offer strictly newer in either order.
 */
function offerFrom(feedPath) {
  const real = fs.readFileSync(feedPath, "utf8");
  const version = String(real.match(/^version:\s*(.+)$/m)?.[1] || "").trim();
  const artifact = String(real.match(/^path:\s*(.+)$/m)?.[1] || "").trim();
  let tree = "";
  try {
    tree = String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "").trim();
  } catch {
    /* no readable package.json: the channel file stands on its own */
  }
  const [major, minor, patch] = version.split(".").map(Number);
  if (!version || [major, minor, patch].some((part) => Number.isNaN(part))) return { error: "its version is not readable (" + version + ")" };
  if (!artifact) return { error: "it names no artifact to download" };
  const [tmajor, tminor, tpatch] = tree.split(".").map(Number);
  const treeIsNewer =
    !Number.isNaN(tmajor) && !Number.isNaN(tminor) && !Number.isNaN(tpatch) && (tmajor > major || (tmajor === major && (tminor > minor || (tminor === minor && tpatch > patch))));
  const base = treeIsNewer ? tree : version;
  const [bmajor, bminor, bpatch] = base.split(".").map(Number);
  return { real, artifact, version, tree, base, offered: bmajor + "." + bminor + "." + (bpatch + 1) };
}

/** Ask the running client the question its own settings page asks. */
async function evaluate(wsUrl, expression) {
  const socket = new WebSocket(wsUrl);
  try {
    // Bounded, because a handshake that neither opens nor errors would otherwise hold the
    // polling loop past its deadline: the deadline is only read between iterations, so one
    // unbounded await turns "nothing answered" into a hang, and a hang reported by the job as
    // "skipped" is worse than a failure with a reason.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the debugging socket did not open")), 6000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("the debugging socket refused"));
        },
        { once: true },
      );
    });
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the page did not answer")), 15000);
      socket.addEventListener("message", (event) => {
        let message = null;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!message || message.id !== 1) return;
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (reply.result?.exceptionDetails) throw new Error(String(reply.result.exceptionDetails.text || "the page threw"));
    return reply.result?.result?.value ?? null;
  } finally {
    socket.close();
  }
}

/** The port the client will be told to debug on, and nobody else's. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function pageTarget(debugPort) {
  // bounded for the same reason as the socket below: a request that stalls must be retried,
  // not waited on (a run killed mid-suite leaves a client behind that holds this port)
  const res = await fetch("http://127.0.0.1:" + debugPort + "/json/list", { signal: AbortSignal.timeout(4000) });
  const list = await res.json();
  return (Array.isArray(list) ? list : []).find((row) => row.type === "page" && row.webSocketDebuggerUrl) || null;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let child = null;
function endClient() {
  if (!child) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        process.kill(child.pid, "SIGKILL");
      }
    }
  } catch {
    /* already gone */
  }
  child = null;
}

/** The local feed, and everything in `dist/` it is allowed to name. */
function startFeedServer(dist, feedName, feed, requests) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(String(req.url || "/").split("?")[0].replace(/^\//, ""));
    requests.push(name);
    if (name === feedName) {
      res.writeHead(200, { "content-type": "text/yaml" });
      res.end(feed);
      return;
    }
    const file = path.join(dist, name);
    if (!file.startsWith(dist) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end("not here");
      return;
    }
    const size = fs.statSync(file).size;
    const asked = String(req.headers.range || "").match(/^bytes=(\d+)-(\d*)$/);
    if (asked) {
      const from = Number(asked[1]);
      const to = asked[2] ? Number(asked[2]) : size - 1;
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
        "content-range": "bytes " + from + "-" + to + "/" + size,
        "content-length": to - from + 1,
      });
      fs.createReadStream(file, { start: from, end: to }).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "accept-ranges": "bytes", "content-length": size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function run() {
  const dist = path.resolve(root, arg("dist", "dist"));
  const exe = findExe();
  const feedName = feedFileName();

  if (!exe) {
    say("SKIPPED (no packed build to drive): run `npm run pack` (or `npm run dist`) first, then this suite drives dist/");
    console.log("\npassed 0  failed 0");
    clearTimeout(watchdog);
    app.exit(0);
    return;
  }
  // the feed the build itself wrote: what the release would publish for this platform
  const feedPath = path.join(dist, feedName);
  if (!fs.existsSync(feedPath)) {
    say("SKIPPED (no " + feedName + " in " + path.relative(root, dist) + "): a packed build writes one with its installers, so run `npm run dist` for this platform");
    console.log("\npassed 0  failed 0");
    clearTimeout(watchdog);
    app.exit(0);
    return;
  }

  const offer = offerFrom(feedPath);
  if (offer.error) {
    ok("the build's own feed can be turned into an offer", false, feedName + " - " + offer.error);
    console.log("\npassed " + passed + "  failed " + failed);
    clearTimeout(watchdog);
    app.exit(1);
    return;
  }
  const artifactPath = path.join(dist, offer.artifact);
  ok("the feed names an artifact this build actually carries", fs.existsSync(artifactPath), offer.artifact);
  if (!fs.existsSync(artifactPath)) {
    console.log("\npassed " + passed + "  failed " + failed);
    clearTimeout(watchdog);
    app.exit(1);
    return;
  }

  console.log("# driving " + path.relative(root, exe).split(path.sep).join("/"));
  console.log("# " + feedName + " says " + offer.version + ", the tree says " + (offer.tree || "(unreadable)") + ", the offer says " + offer.offered + " (via " + offer.artifact + ")");
  if (offer.base !== offer.version) say("the packed app is newer than its own " + feedName + " (the channel file is written by the installers and the app by `pack`), so the offer is built one patch above the app, not above the feed");

  const feed = offer.real.replace(/^version:\s*.+$/m, "version: " + offer.offered);
  const requests = [];
  const { server, port } = await startFeedServer(dist, feedName, feed, requests);
  const base = "http://127.0.0.1:" + port + "/";
  // a free port rather than a fixed one: a client left behind by an interrupted run (or by the
  // user's own) would otherwise answer for ours and the state read would be of another build
  const debugPort = Number(arg("port", "0")) || (await freePort());
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-feed-live-"));
  const lines = [];

  // `--no-attach` on purpose: this is a build being driven from outside, and one that decided to
  // patch and start the Discord installed on this machine would exit before the update loop this
  // file exists to read had run.
  child = spawn(exe, ["--no-attach", "--remote-debugging-port=" + String(debugPort), "--user-data-dir=" + profile], {
    env: { ...process.env, HYPERCORD_UPDATE_FEED: base },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const pid = child.pid;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) lines.push(line.trim());
    });
  }

  // The AppImage-only case, decided before anything is awaited: a Linux run that is not an
  // AppImage has no updater to drive, and what is asserted instead is that it *says so* and never
  // touches the network - see the header.
  const refusesToCheck = process.platform === "linux" && !process.env.APPIMAGE;

  let state = null;
  let target = null;
  const deadline = Date.now() + 210000;
  try {
    while (Date.now() < deadline) {
      await wait(2000);
      try {
        target = target || (await pageTarget(debugPort));
        if (!target) continue;
        state = await evaluate(target.webSocketDebuggerUrl, "(window.hypercord && window.hypercord.update) ? window.hypercord.update.state() : null");
      } catch {
        continue;
      }
      if (!state) continue;
      if (refusesToCheck || state.downloaded || state.error) break;
    }
  } finally {
    endClient();
    server.close();
    await wait(800);
  }

  ok("the packed build starts and its own page answers", Boolean(state), target ? "no update state was readable" : "no page appeared in 3.5 minutes");
  if (state) {
    ok("the update came from this suite's feed, not from a build that shipped its own", state.mode === "feed" && String(state.feed || "").startsWith(base), JSON.stringify({ mode: state.mode, feed: state.feed }));
  }

  if (refusesToCheck) {
    ok("a run that is not an AppImage refuses to check, and names the reason", state?.mode === "elsewhere" && /AppImage/.test(String(state.note || "")), JSON.stringify({ mode: state?.mode, note: state?.note }));
    ok("and it never asked the feed for anything", requests.length === 0, JSON.stringify(requests.slice(0, 4)));
    say("the AppImage path itself is driven only where the run is one: set APPIMAGE to the AppImage this build produced to check it (electron-updater's AppImage updater is inactive without it)");
  } else {
    // An unsigned macOS build cannot install an update, and the download step is where that shows.
    // Accepted, and reported: the honest outcome for a build with no certificate is a named
    // refusal, not a green light.
    const signatureRefusal = process.platform === "darwin" && /signature|code sign|notar|unsigned/i.test(String(state?.error || ""));
    ok(
      "the offer is seen and downloaded: the loop works end to end",
      state?.downloaded === offer.offered || signatureRefusal,
      JSON.stringify({ downloaded: state?.downloaded, error: state?.error, note: state?.note, wanted: offer.offered }),
    );
    ok(
      "with nothing refused and nothing wrong",
      signatureRefusal || (state?.error === "" && state?.note === ""),
      signatureRefusal ? "accepted: an unsigned macOS build" : JSON.stringify({ error: state?.error, note: state?.note }),
    );
    if (signatureRefusal) say("this macOS build is unsigned, so Gatekeeper refused the install step: " + state.error);
    ok("the feed this suite served is the one the client read", requests.includes(feedName), JSON.stringify(requests.slice(0, 4)));
    // The artifact can legitimately arrive two ways, and the suite says which rather than
    // pretending there is only one: over the wire, or out of the updater's own cache when a
    // previous run of *this* suite already downloaded the same version and checksum. A warm
    // cache is a validation, not a shortcut - `downloaded` is only set once the checksum was
    // checked - and a release runner's cache is always cold, which is where the wire path is
    // exercised for real. Either way the state is what proves the update was taken, and this is
    // the assertion that would notice a client which never asked its feed for anything. An exact
    // name and not an `includes`: the `.blockmap` beside the artifact carries its name too, and a
    // run that asked for the block map and nothing else has not downloaded the update.
    const overTheWire = requests.includes(offer.artifact);
    ok(
      "and the artifact reached it: over the wire, or from a copy it had already validated",
      overTheWire || state?.downloaded === offer.offered,
      JSON.stringify({ asked: requests.slice(0, 6), downloaded: state?.downloaded }),
    );
    say("the feed served: " + (requests.length ? requests.slice(0, 6).join(", ") : "nothing"));
    if (!overTheWire) say("the updater already held this exact artifact from an earlier run (same version, same checksum), so it validated that copy instead of downloading it again - a cold cache, which is what a release runner has, fetches it from the feed");
  }

  // Nothing installs: the client was ended with the process tree, so no quit event ran the
  // installer the fake offer was carrying.
  ok("the client was ended, so nothing installs on the way out", pid ? !isAlive(pid) : false, "pid " + pid);

  const interesting = lines.filter((line) => /update|feed|hypercord\] updates/.test(line));
  if (interesting.length) {
    console.log("# what the client logged about it:");
    for (const line of interesting.slice(-6)) console.log("  app: " + line);
  }
  fs.rmSync(profile, { recursive: true, force: true });

  console.log("\npassed " + passed + "  failed " + failed);
  clearTimeout(watchdog);
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(run);
