// language: JavaScript, file: src/attach.js
//
// Which client a run is - the real Discord, patched, or this shell's own window - and what
// to do about the install when Discord has moved on to a new version.
//
// Deliberately not inside src/main.js, and deliberately free of Electron: this is the
// decision that puts a loader in front of somebody's Discord, and a decision like that has
// to be testable on its own (the same reason src/linux-sandbox.js is its own file). The
// shell reads the answer and does the work; the tests read the answer and check it.
//
// Two rules are the whole of the design:
//
//   * **attaching is the default, and it is decided by what is on the machine** rather than
//     by a flag somebody has to remember. A run with a Discord install in front of it *is*
//     that client, patched - and only a machine with nothing to patch, an install that
//     somebody else's loader owns, a development run, a run a harness started (see
//     HARNESS_FLAGS), or an explicit `--no-attach` keeps this window. Every one of those
//     answers carries the reason it was given, because a client that quietly opens its own
//     window instead of the real one is indistinguishable from a client that failed;
//   * **an install is never started unpatched.** Discord's own updater installs a
//     *new* `app-<version>` directory rather than updating the one it had (Squirrel's
//     documented behaviour), so nothing of ours travels with it. The answer to "which
//     install is the client" is therefore always the newest one, and it is inspected and
//     patched before anything is started from it.
import { inspect, listInstalls, patchFreshness } from "./patcher.js";

export const NO_ATTACH = "--no-attach";

/**
 * The switches a harness starts a build with, and never a person.
 *
 * Each one is a run that is being measured or driven from outside: `--perf` measures this
 * shell's own window, `--remote-debugging-port` is how a check attaches to the page, and
 * `--user-data-dir` is a throwaway profile. A build started that way must not patch and
 * launch somebody's installed Discord - the electron suites and `scripts/check-packaged.mjs`
 * start a packaged build exactly like this, and a client that answered by patching the real
 * Discord and exiting would both break the check and touch a machine it was never asked to
 * touch. So these refuse to attach, named in the reason so the shell log says why.
 */
export const HARNESS_FLAGS = ["--perf", "--remote-debugging-port", "--user-data-dir"];

/** The harness switch this run was started with, or an empty string. */
function harnessSwitch(argv) {
  for (const arg of Array.isArray(argv) ? argv : []) {
    const text = String(arg);
    const flag = HARNESS_FLAGS.find((one) => text === one || text.startsWith(one + "="));
    if (flag) return flag;
  }
  return "";
}

/**
 * Should this run be the real Discord, patched, or this window?
 *
 * The reasons are ordered so the most deliberate answer wins: somebody who said
 * `--no-attach` gets that answer whatever else is true, a development run keeps its window
 * unless it explicitly asked (`--attach`), and only then does the machine decide.
 */
export function attachPolicy({ argv = process.argv, env = process.env, packaged = false, found = null } = {}) {
  const asked = (flag) => Array.isArray(argv) && argv.includes(flag);
  if (asked(NO_ATTACH) || String((env && env.HYPERCORD_NO_ATTACH) || "") === "1") {
    return { attach: false, explicit: false, reason: "asked not to attach (" + NO_ATTACH + ")" };
  }
  const harness = harnessSwitch(argv);
  if (harness) return { attach: false, explicit: false, harness, reason: "a run driven by a harness is not somebody's client (" + harness + ")" };
  const explicit = asked("--attach");
  if (!packaged && !explicit) return { attach: false, explicit, reason: "a development run keeps its own window" };
  const lookup = found || { ok: false, error: "no Discord install was looked for" };
  if (!lookup.ok || !lookup.install) return { attach: false, explicit, reason: String(lookup.error || "no Discord install found") };
  const state = inspect(lookup.install);
  // Somebody else's loader owns that directory. Patching over it would be taking a client
  // apart to install ours, which is never what this client is for.
  if (state.state === "foreign") return { attach: false, explicit, install: lookup.install, state: "foreign", reason: "another loader owns that install: " + state.error };
  if (state.state === "missing") return { attach: false, explicit, install: lookup.install, state: "missing", reason: state.error };
  return {
    attach: true,
    explicit,
    install: lookup.install,
    state: state.state,
    reason: explicit ? "asked to attach (--attach)" : "a Discord install is here and it is the client",
  };
}

/**
 * What to do about the newest install: nothing, refresh the record, patch it, or refuse and
 * say why.
 *
 * This is a plan rather than an action, so the caller decides when anything is written - and
 * so the same plan can be taken at boot, after the client Discord was launched exits, and
 * from the settings page, without three copies of the reasoning. `installs` comes from
 * `listInstalls()`, which is newest-first within each channel, so the first entry is the one
 * a person's shortcut will start.
 */
export function updatePlan({ installs = [], version = "" } = {}) {
  const newest = Array.isArray(installs) && installs.length ? installs[0] : null;
  if (!newest) return { action: "none", reason: "no Discord install is here", install: null, state: "" };
  const state = inspect(newest);
  if (state.state === "foreign") {
    // somebody else's loader: hands off, and say whose directory it is
    return { action: "refuse", reason: "another loader owns " + (newest.version || newest.channelName || "that install") + ": " + state.error, install: newest, state: "foreign" };
  }
  if (state.state === "missing") return { action: "refuse", reason: state.error, install: newest, state: "missing" };
  if (state.state === "patched") {
    // Patched by *somebody*. Whether it was this build is the one thing the manifest can
    // answer, and the comparison is numeric (see patchFreshness) - "0.3.9" is not newer than
    // "0.3.10" whatever a string comparison says.
    const freshness = patchFreshness(state.manifest, version);
    if (freshness.older) return { action: "refresh", reason: freshness.reason, install: newest, state: "patched", freshness };
    return { action: "none", reason: "the newest install is patched" + (freshness.state === "current" ? " by this build" : ""), install: newest, state: "patched", freshness };
  }
  // clean or half: half is an install whose asar was moved aside and whose entry directory
  // went missing, which patch() repairs without touching the archive again.
  return { action: "patch", reason: "Discord " + (newest.version || newest.channelName || "unknown") + " is not patched", install: newest, state: state.state };
}

/** Every install on this machine, newest first - the input updatePlan is given. */
export function newestInstalls(opts = {}) {
  return listInstalls(opts);
}
