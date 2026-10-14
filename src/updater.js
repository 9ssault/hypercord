// language: JavaScript, file: src/updater.js
//
// Auto-update, on Electron's own updater. Five rules, and each one is a bug that
// was paid for once already:
//
//   * a development run never updates itself - it would replace the tree you are
//     working in, which is never what anybody wants;
//   * in a packed app the feed comes from the build (electron-builder writes
//     `app-update.yml` into resources), and only an explicit feed overrides it -
//     a packed client must not sit there silently never updating;
//   * a run with no feed at all says so once and then stays quiet, instead of
//     failing in a loop;
//   * the whole thing is silent: no dialogs, no toasts, no "restart to update"
//     prompt. A found update downloads in the background and installs on the way
//     out, so the only thing a user ever notices is a newer version next launch;
//   * nothing here is on a timer you cannot see: one check shortly after launch,
//     then a slow one every few hours (0 turns it off), and every failure is
//     logged and kept in `state` rather than thrown at the app;
//   * and nothing here outlives the client: `stop()` clears *both* timers, detaches
//     the listeners `wire()` attached and marks the updater stopped, so a quit is
//     not held open by a pending settle delay and an in-flight check cannot log,
//     or write state, into a process that is going away;
//   * and it updates *this* app or nothing. The host runs inside Discord's own main
//     process when the client is patched in (see src/loader.cjs), where
//     `app.isPackaged` is true and `process.resourcesPath` are Discord's - so the
//     app's own name is checked first. Without that check the updater would read
//     Discord's updater configuration, compare Discord's version against our feed
//     and, at the worst possible moment, quit Discord and run an installer for it;
//   * and a run that has no installed copy to replace says so instead of failing
//     quietly: a Linux run that is not an AppImage (`APPIMAGE` unset: a deb or a
//     tar.gz install) and the portable Windows exe both answer with the reason, in
//     the same `state` the settings page reads.
import { app } from "electron";
// electron-updater is CommonJS, and its named exports are not always detectable
// from ESM - importing the default and reading the field off it works either way
import electronUpdater from "electron-updater";
import fs from "node:fs";
import path from "node:path";

const { autoUpdater } = electronUpdater;

export function createUpdater({
  log = console.log,
  feed = "",
  everyMs = 6 * 60 * 60 * 1000,
  autoInstall = true,
  // injectable so a test can decide whether a build shipped its own feed
  resourcesPath = process.resourcesPath,
  exists = (file) => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  },
  // Which app this process is, which platform it is on, and what the environment says about
  // how it was started. All three are injected for the same reason `resourcesPath` is: a test
  // has to be able to put the updater inside a patched Discord, or on Linux without an
  // AppImage, on whatever host the suite happens to run on.
  appName = "",
  ownName = "Hypercord",
  platform = process.platform,
  env = process.env,
} = {}) {
  const state = {
    mode: "dev", // dev | built-in | feed | none | foreign | elsewhere
    supported: false,
    feed: "",
    checkedAt: 0,
    version: "",
    downloaded: "",
    error: "",
    // Why this run will not update, when the reason is not a failure: another app's process,
    // or an install with no copy of ours to replace. A page shows it beside the mode, because
    // "not updating in this run" without a reason is the silence this field exists to remove.
    note: "",
    timer: null,
    settle: null, // the one check shortly after launch, until it has fired
    stopped: false,
  };
  const baked = path.join(String(resourcesPath || ""), "app-update.yml");
  // the listeners wire() attached, so stop() can take exactly those back off
  const wired = [];

  function describe() {
    // Never the spread: this object crosses the IPC boundary into the settings
    // pane, and `state.timer` is a Node Timeout - not structured-cloneable, so
    // spreading it made every read of the update state fail with "An object could
    // not be cloned" instead of showing the state. The timer is reported as the
    // fact the pane can actually use, and the settle delay the same way.
    const { timer, settle, ...plain } = state;
    return { ...plain, onTimer: Boolean(timer), onSettle: Boolean(settle), ready: Boolean(state.downloaded) };
  }

  /**
   * Why this run cannot update, decided by the running app and the platform rather than by
   * the feed - and answered before the feed is even read, because none of these has an
   * install of ours to replace and a downloaded artifact would be litter at best.
   *
   *   * a patched client runs the host inside Discord's process (`app.getName()` is
   *     "Discord", `resourcesPath` is Discord's), and Hypercord's job is never to update
   *     Discord or to run an installer for it;
   *   * on Linux the updater is electron-updater's AppImage one, which is inactive unless the
   *     run *is* an AppImage: a deb or a tar.gz is updated by whoever installed it. Downgraded
   *     from "electron-updater quietly does nothing" on purpose - that is indistinguishable
   *     from a broken updater from the outside;
   *   * a portable Windows exe has no installed copy, so an "update" would install a second
   *     client next to it.
   *
   * macOS is deliberately absent: a macOS build has a real update path (the zip in
   * `latest-mac.yml`), and whether it can be installed depends on the signature - a refusal
   * there is Gatekeeper's, and it arrives as an error rather than as a reason decided here.
   */
  function elsewhereReason() {
    const running = String(appName || app.getName?.() || "");
    if (running && running !== ownName) {
      return "this process belongs to " + running + ", so " + ownName + " does not update it";
    }
    if (platform === "linux" && !env.APPIMAGE) {
      return "this Linux run is not an AppImage, so an update has nothing to replace: a deb or a tar.gz install is updated by whoever installed it";
    }
    if (platform === "win32" && env.PORTABLE_EXECUTABLE_FILE) {
      return "this run is the portable exe, which has no installed copy to replace";
    }
    return "";
  }

  function wire() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = autoInstall;
    if (autoUpdater.logger && typeof autoUpdater.logger === "object") {
      // our own log line is enough; electron-updater's console logger would
      // print the feed and the version on every check
      autoUpdater.logger.info = () => {};
      autoUpdater.logger.warn = () => {};
      autoUpdater.logger.error = () => {};
    }
    // each listener is remembered as it is attached: stop() takes these back off,
    // and a listener that outlives the host is a callback into a dead closure
    const on = (event, handler) => {
      wired.push([event, handler]);
      autoUpdater.on(event, handler);
    };
    on("update-available", (info) => log("[hypercord] update available: " + (info && info.version)));
    on("update-not-available", () => {
      if (state.stopped) return;
      state.checkedAt = Date.now();
    });
    on("error", (err) => {
      if (state.stopped) return;
      state.error = String((err && err.message) || err).slice(0, 160);
      log("[hypercord] update error: " + state.error);
    });
    on("update-downloaded", (info) => {
      if (state.stopped) return;
      state.downloaded = String((info && info.version) || "");
      // deliberately no notification: the update is already on disk and installs
      // on quit, so interrupting somebody to tell them is noise, not service
      log("[hypercord] update downloaded: " + state.downloaded + " (installs on quit)");
    });
  }

  /** Take back exactly what wire() attached, tolerating a stub with neither method. */
  function unwire() {
    if (typeof autoUpdater.off === "function") {
      for (const [event, handler] of wired) {
        try {
          autoUpdater.off(event, handler);
        } catch {
          /* one listener that will not come off must not stop the others */
        }
      }
    } else if (typeof autoUpdater.removeAllListeners === "function") {
      try {
        autoUpdater.removeAllListeners();
      } catch {
        /* the same: a stub without listeners to remove is not a failure */
      }
    }
    wired.length = 0;
  }

  function start() {
    // a stopped updater never re-arms: the client it belonged to is going away,
    // and starting it again would leave a fresh timer in a process on its way out
    if (state.stopped) return describe();
    if (!app.isPackaged) {
      state.mode = "dev";
      log("[hypercord] updates: dev run, not checking");
      return describe();
    }
    // Whose app this is, before whose feed it would read: see elsewhereReason. A run with a
    // reason never arms a timer, because there is nothing for a check to lead to.
    const elsewhere = elsewhereReason();
    if (elsewhere) {
      state.mode = appName && appName !== ownName ? "foreign" : "elsewhere";
      state.note = elsewhere;
      log("[hypercord] updates: " + elsewhere);
      return describe();
    }
    const override = String(feed || "").trim();
    if (override) {
      state.mode = "feed";
      state.feed = override;
    } else if (exists(baked)) {
      // electron-builder already put the release feed in the build; using it is
      // the difference between an app that updates and one that never does
      state.mode = "built-in";
    } else {
      state.mode = "none";
      log("[hypercord] updates: this build has no update feed, not checking");
      return describe();
    }

    if (state.mode === "feed") {
      // Two things are read, not one: the feed, and a *config file* - `app-update.yml` in
      // resources - which electron-updater loads for the cache directory its download helper
      // uses (`getOrCreateDownloadHelper`), whatever feed was set. A build that shipped no such
      // file therefore found the update and then failed to download it, with
      // `ENOENT ... resources/app-update.yml` - measured on a packed `--dir` build, where the
      // feed was read, the version comparison said 0.3.6 was available, and the download died
      // on that read. It reads exactly like a broken feed. So a config of our own is written
      // beside the client's own state and the updater is pointed at it; `updateConfigPath` is the
      // only lever upstream offers for that (it is marked private there), and a build without it
      // still gets the feed and fails loudly rather than not checking at all.
      const configFile = path.join(String(app.getPath("userData") || "."), "update-feed.yml");
      try {
        fs.writeFileSync(configFile, "provider: generic\nurl: " + state.feed + "\nupdaterCacheDirName: hypercord-updater\n");
        autoUpdater.updateConfigPath = configFile;
      } catch (err) {
        log("[hypercord] updates: could not write the feed's own config: " + String((err && err.message) || err));
      }
      try {
        autoUpdater.setFeedURL({ provider: "generic", url: state.feed });
      } catch (err) {
        state.error = String((err && err.message) || err).slice(0, 160);
        state.mode = "none";
        log("[hypercord] updates: the feed is not usable, not checking (" + state.error + ")");
        return describe();
      }
    }

    state.supported = true;
    wire();

    const check = () => {
      if (state.stopped) return;
      state.checkedAt = Date.now();
      autoUpdater.checkForUpdates().catch((err) => {
        // a check that was already in flight when the client quit has nothing to
        // report to: writing state now would only log into a dead host
        if (state.stopped) return;
        state.error = String((err && err.message) || err).slice(0, 160);
        log("[hypercord] update check failed: " + state.error);
      });
    };
    state.settle = setTimeout(check, 30000); // let the client settle first
    state.settle.unref?.();
    if (everyMs > 0) {
      state.timer = setInterval(check, Math.max(60 * 1000, everyMs));
      state.timer.unref?.();
    }
    log("[hypercord] updates: checking via " + state.mode);
    return describe();
  }

  /**
   * Take the updater down: both timers, then the listeners. A pending settle delay
   * kept the event loop referenced for up to thirty seconds after a quit, which is
   * the difference between a client that closes and a process that lingers.
   */
  function stop() {
    state.stopped = true;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (state.settle) clearTimeout(state.settle);
    state.settle = null;
    unwire();
    return describe();
  }

  async function checkNow() {
    if (state.stopped) return { ok: false, error: "the updater was stopped" };
    if (!state.supported) {
      return { ok: false, error: state.error || state.note || (state.mode === "dev" ? "a development run never updates itself" : "updates are not configured for this build") };
    }
    try {
      const info = await autoUpdater.checkForUpdates();
      if (state.stopped) return { ok: false, error: "the updater was stopped" };
      state.checkedAt = Date.now();
      state.version = (info && info.updateInfo && info.updateInfo.version) || "";
      state.error = "";
      return { ok: true, version: state.version };
    } catch (err) {
      if (state.stopped) return { ok: false, error: "the updater was stopped" };
      state.error = String((err && err.message) || err).slice(0, 160);
      return { ok: false, error: state.error };
    }
  }

  function installNow() {
    if (!state.downloaded) return { ok: false, error: "nothing has been downloaded yet" };
    // out of the caller's stack: quitAndInstall tears the app down. Deliberately not
    // gated on `stopped`: installing is the one thing that has to survive a stop,
    // because it is what a stop ends in.
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true, version: state.downloaded };
  }

  return { state, describe, start, stop, checkNow, installNow };
}
