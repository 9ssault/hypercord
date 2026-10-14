// language: JavaScript, file: tests/updater/index.mjs
//
// The updater only does anything in a packed app, which is exactly the run a
// development checkout never exercises. So this test packs the app by hand -
// `app.isPackaged` is stubbed true on the live Electron object - and drives the
// real electron-updater through every path: a dev run, a packed build with no
// feed, a packed build that shipped its own `app-update.yml`, an explicit feed
// override, an unreachable feed, the updater's own events, and the timer.
//
// Run it under Electron, not node (`node` cannot resolve `electron`'s app). It
// is a tiny app of its own - Electron needs a package main, not a loose file,
// or it boots and never runs anything:
//
//   npx electron tests/updater
//
// And note the shape: `app.whenReady()` is resolved inside a callback, never
// awaited at the top level of the entry module, because Electron fires `ready`
// only after the main module has finished evaluating - a top-level await of it
// is a deadlock, and this suite hung on exactly that before the watchdog below
// was added.
//
// `package.json` beside this file carries a version on purpose. Electron reads
// `app.getVersion()` from it, and with no version it answers "0.0" - which is not
// valid semver, so `electron-updater` throws while `src/updater.js` is still being
// imported. That happens before the watchdog below exists, so the main process
// died in an error dialog nothing could dismiss: the Linux job sat there for its
// full eight minutes and was killed. Any valid version fixes it; this one is a
// test app's, so it says 0.0.1.
import { app } from "electron";
import electronUpdater from "electron-updater";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUpdater } from "../../src/updater.js";

const { autoUpdater } = electronUpdater;

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

// a hang must report itself rather than sit there being a hang
const watchdog = setTimeout(() => {
  console.log("FAIL the suite hung: " + passed + " passed before it stopped");
  app.exit(2);
}, 60000);
watchdog.unref?.();

async function run() {
  // the one thing this test exists for: pretending to be a packed app
  Object.defineProperty(app, "isPackaged", { value: true, configurable: true });
  ok("the packed stubs take effect", app.isPackaged === true);

  // Every updater below is Hypercord's own, on a platform and an environment this test decides.
  // Both are injected, which is the difference between a suite that asserts the same thing on every
  // runner and one that asserted different things depending on the host it happened to run on: on
  // Linux the AppImage updater is inactive unless the run *is* an AppImage, so a check resolved as
  // "nothing to update" with no request made at all - and that shape is now its own case below
  // instead of being inherited from whichever machine ran the suite.
  const pack = (options = {}) => createUpdater({ appName: "Hypercord", platform: "win32", env: {}, ...options });

  // Whether this *host* can reach a feed at all - which is not the injected `platform` above: the
  // updater class is electron-updater's choice, made from the real `process.platform`, and on Linux
  // that is the AppImage one, inactive unless the run is an AppImage (`TEST_UPDATER_ARCH` is the only
  // thing this suite can tell it). So the two cases that talk to a feed assert both shapes, and on a
  // Linux runner the shape is "nothing to update, and not one request made". The refusals the injected
  // platform *does* decide are section 6, and they are the same on every runner.
  const hostReachesFeed = process.platform !== "linux" || Boolean(process.env.APPIMAGE);

  // a resources directory with and without the feed electron-builder writes
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-bare-"));
  const baked = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-baked-"));
  fs.writeFileSync(path.join(baked, "app-update.yml"), "provider: generic\nurl: http://127.0.0.1:9/updates\nupdaterCacheDirName: hypercord-updater\n");

  /* ---- 1. a production build that shipped no feed: quiet, no timer ------- */

  const bareLines = [];
  const none = pack({ log: (l) => bareLines.push(l), resourcesPath: bare });
  none.start();
  ok("no feed: the run is not treated as supported", none.state.supported === false);
  ok("no feed: it is reported as mode none", none.state.mode === "none", none.state.mode);
  ok("no feed: it says so exactly once", bareLines.filter((l) => l.includes("no update feed")).length === 1, JSON.stringify(bareLines));
  ok("no feed: it records no error", none.state.error === "");
  ok("no feed: it schedules no poll timer", none.state.timer === null);
  const noneCheck = await none.checkNow();
  ok("no feed: checkNow refuses instead of throwing", noneCheck.ok === false && /not configured/.test(noneCheck.error), JSON.stringify(noneCheck));
  ok("no feed: installNow refuses with nothing downloaded", none.installNow().ok === false);

  /* ---- 2. a production build that shipped its own app-update.yml --------- */

  const bakedLines = [];
  const builtIn = pack({ log: (l) => bakedLines.push(l), resourcesPath: baked, everyMs: 0 });
  builtIn.start();
  ok("a shipped feed: supported without any override", builtIn.state.supported === true);
  ok("a shipped feed: it is reported as mode built-in", builtIn.state.mode === "built-in", builtIn.state.mode);
  ok("a shipped feed: the log says how it checks", bakedLines.some((l) => l.includes("checking via built-in")), JSON.stringify(bakedLines));
  const builtInCheck = await builtIn.checkNow();
  if (hostReachesFeed) {
    ok("a shipped feed: an unreachable one fails cleanly", builtInCheck.ok === false && builtInCheck.error.length > 0, JSON.stringify(builtInCheck));
  } else {
    ok("a shipped feed: an unreachable one is nothing to update, not a throw", builtInCheck.ok === true && builtInCheck.version === "" && builtIn.state.error === "", JSON.stringify(builtInCheck));
  }
  ok("a shipped feed: no poll timer when everyMs is 0", builtIn.state.timer === null);

  /* ---- 3. an explicit feed override that cannot be reached -------------- */

  const feedLines = [];
  const dead = pack({ log: (l) => feedLines.push(l), feed: "http://127.0.0.1:9/updates", resourcesPath: baked, everyMs: 0 });
  dead.start();
  ok("an override: it wins and is reported as mode feed", dead.state.mode === "feed" && dead.state.feed.endsWith("/updates"), dead.state.mode);
  // The bug this covers, measured on a packed `--dir` build: electron-updater reads a config file
  // (`app-update.yml` in resources) for its download cache directory whatever feed it was given, so
  // a build that shipped none found the update and then failed the *download* with
  // `ENOENT ... app-update.yml`. A config of our own is written for the override instead.
  const feedConfig = path.join(app.getPath("userData"), "update-feed.yml");
  ok(
    "an override: and the config the updater needs to download is written, not assumed",
    fs.existsSync(feedConfig) && fs.readFileSync(feedConfig, "utf8").includes("url: http://127.0.0.1:9/updates"),
    feedConfig,
  );
  ok("an override: it counts as supported", dead.state.supported === true);
  const deadCheck = await dead.checkNow();
  if (hostReachesFeed) {
    ok("an override: checkNow reports the failure instead of throwing", deadCheck.ok === false && deadCheck.error.length > 0, JSON.stringify(deadCheck));
    ok("an override: the reason is recorded in state", dead.state.error.length > 0, dead.state.error);
  } else {
    ok("an override: checkNow resolves without throwing", deadCheck.ok === true && deadCheck.version === "", JSON.stringify(deadCheck));
    ok("an override: no check was made, so nothing is recorded", dead.state.error === "", dead.state.error);
  }
  ok("an override: the reason never contains a token field", !/token|Bearer/i.test(dead.state.error));

  /* ---- 4. the updater's own events -------------------------------------- */

  const eventLines = [];
  const seen = [];
  const live = pack({ log: (l) => eventLines.push(l), feed: "http://127.0.0.1:9/updates", resourcesPath: bare, everyMs: 60000 });
  // what the updater attaches to wherever it goes, counted across every event: closing
  // the client has to leave the same number behind, not merely stop the timers
  const totalListeners = () => autoUpdater.eventNames().reduce((total, name) => total + autoUpdater.listenerCount(name), 0);
  const listenersBeforeStart = totalListeners();
  live.start({ notify: (title, body) => seen.push([title, body]) });
  ok("starting it is what attaches its listeners", totalListeners() > listenersBeforeStart, "before " + listenersBeforeStart + " after " + totalListeners());
  ok("a poll timer exists while running", live.state.timer !== null);
  ok("the update downloads itself with no prompt", autoUpdater.autoDownload === true);
  ok("the update installs itself on quit", autoUpdater.autoInstallOnAppQuit === true);

  autoUpdater.emit("update-available", { version: "9.9.9" });
  ok("an available update is logged once", eventLines.some((l) => l.includes("update available: 9.9.9")), JSON.stringify(eventLines));

  autoUpdater.emit("error", new Error("the feed said 500"));
  ok("an updater error is recorded, not thrown", live.state.error === "the feed said 500", live.state.error);
  ok("an updater error is logged", eventLines.some((l) => l.includes("update error: the feed said 500")));

  autoUpdater.emit("update-downloaded", { version: "9.9.9" });
  ok("a downloaded update is remembered", live.state.downloaded === "9.9.9", live.state.downloaded);
  ok("a downloaded update is logged", eventLines.some((l) => l.includes("update downloaded: 9.9.9")), JSON.stringify(eventLines));
  ok("a downloaded update says nothing to the user", seen.length === 0, JSON.stringify(seen));
  ok("describe() says an update is ready", live.describe().ready === true);

  // the installer itself is electron-updater's business (and quitting the app in
  // a test would hang the run), so the call is watched instead of performed
  let installed = 0;
  const realQuitAndInstall = autoUpdater.quitAndInstall.bind(autoUpdater);
  autoUpdater.quitAndInstall = () => {
    installed += 1;
  };
  const install = live.installNow();
  await new Promise((resolve) => setTimeout(resolve, 50));
  ok("installNow is offered once something is downloaded", install.ok === true && install.version === "9.9.9", JSON.stringify(install));
  ok("installNow actually asks the updater to install", installed === 1, "calls " + installed);
  ok("the update is set to install itself on quit", live.state.supported === true);
  autoUpdater.quitAndInstall = realQuitAndInstall;

  live.stop();
  ok("stop() clears the poll timer", live.state.timer === null);
  // the two things a quit used to leave running: the settle timeout scheduled at start,
  // and the listeners on the shared autoUpdater - which is a module-level singleton, so a
  // listener left behind outlives the window that installed it
  ok("and the timeout start() scheduled for a quieter moment", !live.state.settle, String(live.state.settle));
  ok("and the listeners it attached, so nothing is delivered after the stop", totalListeners() === listenersBeforeStart, "before " + listenersBeforeStart + " after " + totalListeners());
  ok("describe() reports the stopped shape a page has to clone", live.describe().stopped === true && live.describe().onTimer === false && live.describe().onSettle === false && live.describe().timer === undefined, JSON.stringify(live.describe()));
  const linesAtStop = eventLines.length;
  autoUpdater.emit("error", new Error("delivered after the stop"));
  ok("an event that arrives after the stop is ignored", live.state.error === "the feed said 500" && eventLines.length === linesAtStop, JSON.stringify(eventLines.slice(-2)));
  live.start();
  ok("and a stopped updater does not arm itself again", live.state.timer === null && live.describe().stopped === true, JSON.stringify(live.describe()));
  const afterStop = await live.checkNow();
  ok("a check after the stop is refused instead of reaching the feed", afterStop.ok === false && /stopped/.test(afterStop.error), JSON.stringify(afterStop));

  /* ---- 5. a development run must never update itself --------------------- */

  Object.defineProperty(app, "isPackaged", { value: false, configurable: true });
  const devLines = [];
  const dev = pack({ log: (l) => devLines.push(l), feed: "http://127.0.0.1:9/updates", resourcesPath: baked });
  dev.start();
  ok("dev run: it does not even try", dev.state.supported === false && dev.state.mode === "dev" && devLines.some((l) => l.includes("dev run")), JSON.stringify(devLines));
  ok("dev run: no poll timer is left behind", dev.state.timer === null);
  const devCheck = await dev.checkNow();
  ok("dev run: checkNow explains itself", devCheck.ok === false && /development run/.test(devCheck.error), JSON.stringify(devCheck));

  /* ---- 6. whose app this is, and which runs have somewhere to put an update */

  // section 5 unpacks the app on purpose, and this section is about what a *packed* run does
  Object.defineProperty(app, "isPackaged", { value: true, configurable: true });

  const foreignLines = [];
  const foreign = pack({ appName: "Discord", log: (l) => foreignLines.push(l), resourcesPath: baked, everyMs: 60000 });
  foreign.start();
  ok("a process that belongs to another app is not updated by us", foreign.state.mode === "foreign" && foreign.state.supported === false, foreign.state.mode);
  ok("and it names the app whose process it is", /belongs to Discord/.test(foreign.state.note), foreign.state.note);
  ok("and it is said once, in the log, with no timer armed", foreignLines.filter((l) => l.includes("belongs to Discord")).length === 1 && foreign.state.timer === null, JSON.stringify(foreignLines));
  const foreignCheck = await foreign.checkNow();
  ok("asking it to check answers that reason rather than reaching a feed", foreignCheck.ok === false && /belongs to Discord/.test(foreignCheck.error), JSON.stringify(foreignCheck));
  ok("and the reason travels to the page in describe()", foreign.describe().note === foreign.state.note && foreign.describe().mode === "foreign", JSON.stringify(foreign.describe()));

  const linuxBare = pack({ platform: "linux", log: () => {}, resourcesPath: baked, everyMs: 60000 });
  linuxBare.start();
  ok("a Linux run that is not an AppImage has nothing to replace", linuxBare.state.mode === "elsewhere" && linuxBare.state.supported === false, linuxBare.state.mode);
  ok("and the reason names what an update would need", /not an AppImage/.test(linuxBare.state.note) && /deb or a tar[.]gz/.test(linuxBare.state.note), linuxBare.state.note);
  ok("and nothing is armed for it: no poll, no settle delay", linuxBare.state.timer === null && !linuxBare.state.settle);
  const linuxCheck = await linuxBare.checkNow();
  ok("asking anyway answers the same reason", linuxCheck.ok === false && linuxCheck.error === linuxBare.state.note, JSON.stringify(linuxCheck));

  const linuxAppImage = pack({ platform: "linux", env: { APPIMAGE: "/home/tester/Hypercord.AppImage" }, log: () => {}, resourcesPath: baked, everyMs: 0 });
  linuxAppImage.start();
  ok("a Linux AppImage does have somewhere to put an update", linuxAppImage.state.mode === "built-in" && linuxAppImage.state.supported === true, linuxAppImage.state.mode);
  ok("and carries no refusal note", linuxAppImage.state.note === "", linuxAppImage.state.note);

  const portable = pack({ env: { PORTABLE_EXECUTABLE_FILE: "C:\\Hypercord-portable.exe" }, log: () => {}, resourcesPath: baked, everyMs: 0 });
  portable.start();
  ok("the portable exe has no installed copy to replace", portable.state.mode === "elsewhere" && /portable exe/.test(portable.state.note), portable.state.note);

  const mac = pack({ platform: "darwin", log: () => {}, resourcesPath: baked, everyMs: 0 });
  mac.start();
  ok("macOS is not refused: it has a real update path", mac.state.mode === "built-in" && mac.state.supported === true && mac.state.note === "", JSON.stringify(mac.describe()));
  mac.stop();

  fs.rmSync(bare, { recursive: true, force: true });
  fs.rmSync(baked, { recursive: true, force: true });

  clearTimeout(watchdog);
  console.log("\npassed " + passed + "  failed " + failed);
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(run);
