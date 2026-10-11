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
//     logged and kept in `state` rather than thrown at the app.
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
} = {}) {
  const state = {
    mode: "dev", // dev | built-in | feed | none
    supported: false,
    feed: "",
    checkedAt: 0,
    version: "",
    downloaded: "",
    error: "",
    timer: null,
  };
  const baked = path.join(String(resourcesPath || ""), "app-update.yml");

  function describe() {
    return { ...state, ready: Boolean(state.downloaded) };
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
    autoUpdater.on("update-available", (info) => log("[hypercord] update available: " + (info && info.version)));
    autoUpdater.on("update-not-available", () => {
      state.checkedAt = Date.now();
    });
    autoUpdater.on("error", (err) => {
      state.error = String((err && err.message) || err).slice(0, 160);
      log("[hypercord] update error: " + state.error);
    });
    autoUpdater.on("update-downloaded", (info) => {
      state.downloaded = String((info && info.version) || "");
      // deliberately no notification: the update is already on disk and installs
      // on quit, so interrupting somebody to tell them is noise, not service
      log("[hypercord] update downloaded: " + state.downloaded + " (installs on quit)");
    });
  }

  function start() {
    if (!app.isPackaged) {
      state.mode = "dev";
      log("[hypercord] updates: dev run, not checking");
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
      state.checkedAt = Date.now();
      autoUpdater.checkForUpdates().catch((err) => {
        state.error = String((err && err.message) || err).slice(0, 160);
        log("[hypercord] update check failed: " + state.error);
      });
    };
    setTimeout(check, 30000); // let the client settle first
    if (everyMs > 0) {
      state.timer = setInterval(check, Math.max(60 * 1000, everyMs));
      state.timer.unref?.();
    }
    log("[hypercord] updates: checking via " + state.mode);
    return describe();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    return describe();
  }

  async function checkNow() {
    if (!state.supported) {
      return { ok: false, error: state.error || (state.mode === "dev" ? "a development run never updates itself" : "updates are not configured for this build") };
    }
    try {
      const info = await autoUpdater.checkForUpdates();
      state.checkedAt = Date.now();
      state.version = (info && info.updateInfo && info.updateInfo.version) || "";
      state.error = "";
      return { ok: true, version: state.version };
    } catch (err) {
      state.error = String((err && err.message) || err).slice(0, 160);
      return { ok: false, error: state.error };
    }
  }

  function installNow() {
    if (!state.downloaded) return { ok: false, error: "nothing has been downloaded yet" };
    // out of the caller's stack: quitAndInstall tears the app down
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true, version: state.downloaded };
  }

  return { state, describe, start, stop, checkNow, installNow };
}
