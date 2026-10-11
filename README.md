# Hypercord

Our own Discord client, and when a real Discord is installed it *can* be Discord:
started with `--attach`, the client patches the official desktop client to load
Hypercord's loader (byte-exact - `app.asar` is renamed, never rewritten) and
starts it, so the client you chat in is the actual Discord with our loader in
front of it, not a window of ours showing the web app. Without `--attach` - and on
a machine with no Discord installed - the Electron window is the client. The
installer installs Hypercord and touches nothing else: patching is the client's
job, at the one moment it can be sure it is running and can report a refusal.

**This repository carries two clients.** This README, and everything under `src/`,
`plugins/`, `vendor/`, `tests/`, `scripts/` and `build/`, is the desktop client.
The Android client - the original Hypercord, an APK - is the tree that came with
this repository: `android/`, `core/`, `utils/`, and its own `plugins/`, `scripts/`
and `tests/` siblings; its README is kept verbatim in
[docs/ANDROID-README.md](docs/ANDROID-README.md). The two were separate histories
and are merged here, so a path that exists in both is whichever one this file
does not describe. On top of either, the Vencord/Equicord plugin platform (rebranded) and
the Hyper plugins that drive the selfbot's control server.

## Rules this client is built to

| Rule | Why it matters |
| --- | --- |
| **No tray, no resident process, no login item** | closing the window ends Hypercord. Nothing of ours keeps running and nothing of ours starts at boot - a chat client that squats in the tray holds a renderer and a few hundred megabytes for a feature nobody asked for |
| A disabled plugin is never imported, and never evaluated | code that does not run costs no CPU and no RAM, whatever the catalogue's size |
| Any plugin outside the default set is loaded on demand (`import()`), never at start | start time and memory track what you use, not what exists |
| The catalogue browser reads metadata (a manifest), not plugin code | browsing 371 plugins loads kilobytes, not megabytes |
| Themes are CSS at one injection point, and never execute | a theme costs a stylesheet, never a script |
| Updates are silent | found in the background, downloaded in the background, installed on the way out. No dialog, no toast, no "restart to update" prompt |
| No timers while idle | the rail, the manager sheet and the plugin host wake on events, not on a clock. `PERF.md` records the reading |
| Every call can fail out loud | no click is ever a dead end: the rail and the manager say what went wrong in text |

## Features stay, weight does not

The whole ecosystem is present - that is the point of a client mod:

* **every plugin** from the vendored Vencord/Equicord catalogue is in the manager
  (371 entries), browsable, searchable, enable/disable-able, each with a settings
  form; the **Hyper set** is the five that are on by default and the only ones
  started on a first run;
* **themes**: local `.theme.css` files, online themes by URL fetched only at
  install time, quick CSS - all of it, and a hostile theme is refused rather than
  stripped;
* **accounts**: the control server's accounts, and logging this client in as one
  of them, with the token going straight into the page's storage and never into a
  log, a state file in clear, or the UI;
* the Hyper plugins: `hyperBridge`, `hyperRail`, `hyperAccounts`, `hyperPanes`,
  `hypercordRPC`.

## How it runs

Two paths, and the shell picks the better one:

1. **`--attach` (and the real client).** `src/patcher.js` finds the installed
   Discord (Windows `%LOCALAPPDATA%\Discord{,PTB,Canary}\app-<v>\resources`,
   macOS `/Applications|~/Applications/Discord{ PTB, Canary}.app`, Linux
   `~/.config/discord*/app-<v>/resources`, package roots and Flatpak), renames
   `app.asar` to `hypercord.app.asar` - never rewriting it, so unpatch is
   byte-exact - and writes a `resources/app` entry point that requires
   `src/loader.cjs` and then hands off to the real client. The loader injects one
   `<style>` element and one rail host element into Discord's own windows.
2. **The fallback window.** No Discord installed: `src/main.js` opens Discord web
   with the same preload, rail and plugin host.

Everything of ours lives inside Discord's own window: the rail on an edge of it,
the token option under its login fields, and the manager as a sheet over it that
the rail's Manager button, `Ctrl+Shift+H`'s rail, or the **Hypercord** entry in
Discord's settings opens. There is no second window to find or raise, and the
manager is one tab per thing - commands, plugins, our own Hyper plugins, themes,
logs, accounts, access keys.

## Layout

```
hypercord/
  package.json          electron, electron-builder and electron-updater
  src/main.js           the shell: one window, attachment, no tray, quits on close
  src/preload.cjs       the bridge, the rail's behaviour, the one style element
  src/api.js            control-server client (Bearer token, never logged)
  src/plugin-host.js    manifest-driven host: lazy import, handles, settings, isolation
  src/themes.js         CSS-only themes: local, online-at-install, quick CSS, sanitised
  src/patcher.js        finding, patching, unpatching and launching a real Discord
  src/loader.cjs        what a patched Discord requires; injects into its windows
  src/updater.js        electron-updater, silent, installs on quit
  src/rail.html|css     the rail markup and its scoped stylesheet
  src/prompt.html       the token option that sits under Discord's login fields
  src/passkeys.cjs      the one passkey policy: no prompt nobody asked for
  src/panes.html|js|css the manager sheet, mounted inside the Discord window:
                        commands, plugins, Hyper plugins, themes, logs, accounts,
                        access keys, one tab each
  src/tokens.js         the user-token store: in the OS keychain, never in a log
  plugins/hyper/        the five Hyper plugins, and the set that is on by default
  plugins/manifest.json 371 entries of metadata: what the manager reads
  vendor/equicord       the vendored upstream core (GPL-3.0, licence kept verbatim)
  tests/                plugin-host, themes, patcher (node); updater, preload (electron)
  PERF.md               the budget and the real readings
```

## Tests

```bash
npm test           # every suite, in one go
npm run test:units # node: plugin-host, themes, patcher
npm run test:electron # electron: updater, preload + panes injection
```

## Licence

Vencord and Equicord are GPL-3.0: this fork stays **GPL-3.0-or-later**, ships its
source, and keeps upstream attribution. Rebranding covers identity - name, icons,
app id, install directory, window names - never the licence.

## State of play

Working and verified by the suites: the plugin host (metadata-only catalogue,
first-run seeding of the Hyper set, lazy enable, dependency order, error
isolation, live handles, declared setting defaults), the theme system (one
injection point, nothing fetched in the background, hostile input refused), the
patcher (byte-exact rename, idempotent, foreign installs refused, dry run,
rollback), the preload (rail mount, theme style element, plugin list, working
buttons) and the manager UI (all five views, real data, no page errors).

Not yet true, and not claimed: the RSS budget in `PERF.md`, the vendored
catalogue's TypeScript plugin *bodies* (the host refuses a `.ts`/`.tsx` entry with
"TypeScript source, not built" rather than pretending - the upstream catalogue
needs its own build step to become loadable JavaScript), the served `/discord`
fallback, a signed installer, and the Android build.
