// language: JavaScript, file: src/linux-sandbox.js
//
// The Linux answer to "Network service crashed or was terminated".
//
// Chromium's helper processes - the network service, the GPU process, the
// renderers - run inside its OS-level sandbox: the setuid `chrome-sandbox`
// helper, or an unprivileged user namespace. Inside an AppImage neither is
// reliable: the helper loses its setuid bit on the FUSE mount, and the kernels
// users actually run (Ubuntu 24.04's AppArmor
// `kernel.apparmor_restrict_unprivileged_userns`, Debian's
// `kernel.unprivileged_userns_clone=0`, and most containers) refuse the
// namespace. When that happens the main process starts fine and every child
// dies at birth - the log shows exactly one Chromium line and then every page
// load fails with ERR_FAILED, which is the report this module exists for.
//
// The answer is `--no-sandbox`, which disables only the *OS-level* sandbox:
// the window is still built with `sandbox: true`, so the preload isolation the
// preload suite asserts is unchanged (the release pipeline already leans on the
// same distinction for its Linux test runs - see `.github/workflows/release.yml`).
//
// This module decides; `src/main.js` applies. It is pure and takes everything
// from its arguments so the unit suite can drive every branch on any platform.

/**
 * Whether the Chromium OS-level sandbox must be turned off for this launch.
 *
 * @param {object} [facts]
 * @param {string} [facts.platform] `process.platform`
 * @param {object} [facts.env] `process.env`
 * @param {string[]} [facts.argv] `process.argv`
 * @param {number|null} [facts.euid] `process.geteuid()` where available, else null
 * @param {boolean} [facts.sandboxSwitchPresent] `app.commandLine.hasSwitch("no-sandbox")`
 * @returns {{ disable: boolean, reason: string }} `disable` says to launch with
 *   `--no-sandbox`; `reason` is the one line the shell logs when it does.
 */
export function sandboxDecision(facts = {}) {
  const platform = facts.platform ?? process.platform;
  const env = facts.env ?? process.env;
  const argv = facts.argv ?? process.argv;
  const euid = facts.euid ?? (typeof process.geteuid === "function" ? process.geteuid() : null);
  const already = facts.sandboxSwitchPresent ?? argv.some((arg) => arg === "--no-sandbox" || arg.startsWith("--no-sandbox="));

  // An explicit opt-out wins over every heuristic, in both directions: setting
  // it to "0" keeps the sandbox even inside an AppImage, anything else is read
  // as "off". The name is ours so it can never collide with Chromium's.
  const force = String(env.HYPERCORD_SANDBOX ?? "").toLowerCase();
  if (force === "0" || force === "off" || force === "false" || force === "no") {
    return { disable: false, reason: "HYPERCORD_SANDBOX keeps the sandbox on" };
  }

  if (platform !== "linux") return { disable: false, reason: "not linux" };
  if (already) return { disable: true, reason: "already requested on the command line" };
  if (String(env.ELECTRON_DISABLE_SANDBOX ?? "") === "1") {
    return { disable: true, reason: "ELECTRON_DISABLE_SANDBOX is set" };
  }
  // Chromium refuses the setuid helper as uid 0 outright; without the switch the
  // client does not start at all, sandbox or no sandbox.
  if (euid === 0) {
    return { disable: true, reason: "running as root, where the sandbox helper refuses to run" };
  }
  // The reported failure: the AppImage's helper cannot hold setuid on the FUSE
  // mount, and where the kernel additionally refuses unprivileged user
  // namespaces the network service dies and every load fails ERR_FAILED.
  if (env.APPIMAGE) {
    return { disable: true, reason: "running as an AppImage (" + env.APPIMAGE + "), whose sandbox helper cannot work" };
  }
  return { disable: false, reason: "no reason to turn the sandbox off" };
}
