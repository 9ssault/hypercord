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
| No timers while idle | the settings pages and the plugin host wake on events, not on a clock. `PERF.md` records the reading |
| Every call can fail out loud | no click is ever a dead end: every page says what went wrong, in text, in the line above it |

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
* the Hyper plugins: `hyperBridge`, `hyperPanes`, `hyperAccounts`,
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
   `<style>` element into Discord's own windows - the themes and the styles for the
   two pieces of Hypercord that live in Discord's tree - and nothing else.
2. **The fallback window.** No Discord installed: `src/main.js` opens Discord web
   with the same preload, settings pages and plugin host.

Everything of ours lives inside Discord's own window: the token option under its
login fields, and Hypercord's settings as **pages inside Discord's own settings** -
one entry per section in Discord's sidebar (commands, plugins, our own Hyper
plugins, themes, logs, accounts, access keys), rendered in Discord's settings
content column, wearing Discord's own classes and its own colour variables so the
client's theme styles them. There is no second window, no overlay rail and no sheet
of our own to find or raise; leaving Discord's settings leaves these pages with it.

## Setup

Prerequisites: Node on Windows, macOS or Linux (CI uses 20; `electron` 44).
There is **no lockfile** in this tree, so `npm ci` cannot run - use `npm install`
and commit the lockfile if you want reproducible installs.

```bash
npm install
npm test              # every suite: units (node), then the electron ones
```

### Desktop - run it

```bash
npm start                     # the Electron window: Discord web + our preload
npm start -- --attach         # patch a real Discord and start *that* as the client
npm run perf                  # --perf=45: the same client, measures each process, quits
```

`--attach` needs an installed Discord. `src/patcher.js` looks under Windows
`%LOCALAPPDATA%\Discord{,PTB,Canary}\app-<v>\resources`, macOS
`/Applications|~/Applications/Discord{ PTB, Canary}.app`, Linux
`~/.config/discord*/app-<v>/resources`, package roots and Flatpak. It renames
`app.asar` to `hypercord.app.asar` (never rewritten, so unpatch is byte-exact)
and writes a `resources/app` entry point that requires `src/loader.cjs`. A
`resources/app` that is not ours, and a directory that is not a Discord install,
are left alone and refused rather than touched. With no Discord installed, the
Electron window *is* the client, and nothing of ours starts at boot or stays
resident: closing the window ends Hypercord.

### Desktop - build it

```bash
npm run vendor        # merge + rebrand the vendored catalogue into plugins/manifest.json
npm run vendor:check  # the same audit, read-only
npm run pack          # electron-builder --dir -> dist/win-unpacked (or the platform equivalent)
npm run check:packaged -- --fresh   # start the packed exe and read its page
npm run dist          # the installers, into dist/
```

`build` in `package.json` decides what each platform gets:

| Platform | Targets | Artifact names in `dist/` |
| --- | --- | --- |
| Windows | `nsis` setup + `portable`, x64 and arm64 | `Hypercord-<version>-win-<arch>-setup.exe`, `...-portable.exe` |
| macOS | `dmg` + `zip`, x64 and arm64 | `Hypercord-<version>-mac-<arch>.dmg`, `....zip` |
| Linux | `AppImage`, `deb`, `tar.gz`, x64 and arm64 | `Hypercord-<version>-linux-<arch>.AppImage`, `....deb`, `....tar.gz` |

One run can do several targets: `npm run dist -- --win --linux --x64`.
**Signing is not configured in this tree** - there is no certificate, notarisation
or `CSC_*` step, so macOS and Windows artifacts are unsigned; macOS will warn on
first open, and Gatekeeper refuses an unsigned replacement, so a macOS build must
be signed for the silent updater to install into it. Building macOS artifacts
needs macOS; Windows and Linux artifacts can both be produced from either.

`npm run release` is the gate, in this order and no other: the vendor audit, the
suites, `pack`, a freshness check (a `dist/` older than `src/` is refused - that
is the failure this script exists for), the packaged check on a throwaway
profile, and only then the installers, always with `--publish never`. Flags:
`--skip-tests`, `--no-fresh`, `--allow-dirty`, `--dry-run`. Nothing in it
publishes; uploading artifacts is a separate, deliberate act.

### Android - the APK

It is a **Manager + Loader** pair, not a fork: Manager downloads Discord's own
APK splits, verifies their signer and version, patches the Loader in with
LSPatch, and hands the result to Android's package installer. The installed
client runs Discord's own React Native UI, with the plugin and theme runtime
under Discord's Settings under the Hypercord entry. Documented requirements:
Java 21, Python 3.9+, Android SDK platform 36 and build-tools 36.0.0.

**This tree cannot build the APK as it stands.** The commands the Android docs
and CI name - `npm run build:addons`, `python3 scripts/build_android.py`,
`npm run build`, `npm run release:zip`, `scripts/candidate_artifacts.py` - are
not here: `scripts/` holds only `vendor.mjs`, `release.mjs`,
`check-packaged.mjs`, `measure.mjs`, `make-icons.mjs` and `patch_runtime.py`,
`android/` has no Gradle wrapper and no `build.gradle`/`settings.gradle`, and the
Android project has no `package.json` of its own (so its `npm ci` cannot run
either, and the repository has no lockfile). What *is* here: the Java sources
(`android/manager`, `android/loader`), the JS runtime (`core/`, `utils/`,
`plugins/`, `themes/`), the Android Node tests (`tests/*.test.mjs`, run one at a
file with `node --test tests/<name>.test.mjs`), and the tag-triggered release
workflow (`.github/workflows/android-release.yml`), which expects exactly the
missing scripts. Treat the APK as source-only: no build is claimed, and the
output path the docs name (`public/releases/Assault-Manager.apk`, kept for the
reason in its branding note, and copied to `Hypercord-Manager.apk` /
`Hypercord-Loader.apk` with `SHA256SUMS` by that workflow) is where a complete
tree would put it.

Installing it, once built, is the flow in [docs/ANDROID-README.md](docs/ANDROID-README.md):

1. install the Manager APK and open it;
2. tap **Download & prepare client** - Manager fetches the base, ABI, language and density splits itself;
3. tap **Install prepared update** and allow installs from Manager;
4. open Hypercord and sign in with Discord's own login.

Keep Manager installed and its data intact: it holds the private key the client
is signed with, and clearing it means future updates need a fresh install. The
patched client keeps `com.discord` but is signed by Manager, so it cannot update
an official Discord install - Android reports a signing conflict. Sideloading is
the only distribution here; expect Play Protect to warn.

**Android without an APK:** `pwa/manifest.webmanifest` is in this tree, so the
client can be installed from a browser as a web app. The route that serves it
(`/discord`) lives in the control server, not in this repository.

### Plugins, themes and sources

* **Plugins.** The vendored Vencord/Equicord catalogue (371 entries) is written
  by `npm run vendor` into `plugins/manifest.json`, which is metadata only that
  the host reads; a plugin's code is imported the moment it is enabled and never
  before. `plugins/hyper/` holds our five, and they are the only ones on at
  first run.
* **Themes.** Local `.theme.css` files, online themes by URL (fetched once, at
  install time) and quick CSS, all through the one injection point in `src/themes.js`.
* **Sources.** `addon-sources.json` is the catalogue of plugin and theme sources
  other clients publish - Aliucord's `manifest.json`, the Vendetta and Bunny
  plugin proxies, Revenge's `index.json`, Equicord's `Equibuilds` JSON, plus the
  browseable Vencord, BetterDiscord and Replugged listings - and
  [docs/addon-sources.md](docs/addon-sources.md) says what each one returns and
  how to fetch it. The limit is honest: those plugins are written for *their*
  runtimes. This client installs only its own addon dialect (the bounded
  interpreter in [docs/addon-framework.md](docs/addon-framework.md): `.js`/`.txt`,
  no loops, imports, async or prototype access), and the desktop host refuses a
  TypeScript plugin body with "TypeScript source, not built" instead of
  pretending. Sources are for browsing and fetching; what installs has to be in
  this dialect.

### Signing in with a token

Run `npm start` and the token card sits directly under Discord's own email and
password fields; the Accounts page does the same for a stored account. A
pasted token is **checked with Discord first** - only a token whose identity
Discord confirms is stored - and then kept by the operating system's keychain
(`safeStorage`, through `src/tokens.js`); what reaches disk is metadata plus the
cipher's own output, and the manager lists a fingerprint and the last four
characters of a token, never the token itself. Signing in writes the token where
that page keeps it and sends the window to the app route, because the login page
never restores a session; "stored" and "signed in" are reported as the two
different things they are, and a refusal says which half failed. Every attempt
appends one line to `signin.log` in the app's userData directory (Windows
`%APPDATA%\Hypercord`, macOS `~/Library/Application Support/Hypercord`, Linux
`~/.config/Hypercord`): the form, whether the client used the token, and where
it landed - never the token, never a header value.

## Where the code comes from

Two clients, one repository, and none of the interesting parts are Discord's:

* **The plugin platform is upstream's, rebranded.** `vendor/equicord` is the build
  base (it already contains Vencord's core) and `vendor/vencord` is merged into it
  by `npm run vendor` (`scripts/vendor.mjs`): a plugin folder Equicord does not have
  is added, and where both ship the same folder **Equicord wins**. The rebrand
  changes display strings only - the identifiers the runtime and the injector need
  keep their upstream names (`Vencord` the renderer global, the `vencord:` and
  `equicord:` protocols, the `~plugins` virtual import, `retainEquicord`,
  `generateEquicordPluginJson`, `EquicordData`, source-map URLs) - and no LICENSE
  file or credit line is ever opened, let alone rewritten. `about.html` is the one
  file the display-string audit exempts, because naming upstream is its whole job.
* **Attribution is recorded, and checkable.** `plugins/manifest.json` carries
  `provenance`: core Equicord at `e0e85c8d4f6dc73aac9368cf3f4b2200eac4d4b4`, merged
  Vencord at `16ec4ea838899706019e7f472e45f055070abeb1` - the commits the checkouts
  were at when the catalogue was generated. `npm run vendor:check` re-reads them and
  re-runs the audit without changing anything. Both upstream licence texts are in
  the tree exactly as shipped, at `vendor/vencord/LICENSE` and
  `vendor/equicord/LICENSE`. Which half an entry came from is not a guess: every
  catalogue entry carries its `entry` file and a `source` of `upstream` or
  `hypercord`, and its `authors` are resolved out of upstream's own `Devs` map -
  `authorRefs` keeps the raw reference beside the resolved name so attribution can
  be checked rather than believed.
* **Ours.** `plugins/hyper/` (the four that are on by default), `src/` (the shell,
  patcher, preload, the settings pages, the plugin host, the theme system and the
  token store),
  `plugins/examples/` with `themes/examples/`, and the Android client in `android/`,
  `core/`, `utils/`.
* **Not ours, and not bundled.** Discord's own client is never in this repository.
  The desktop path renames an installed `app.asar` byte-exact and leaves a
  `resources/app` entry point that requires our loader (`src/patcher.js`), so
  unpatching restores the original bytes; the Android path downloads Discord's own
  APK splits and verifies them on device before a loader is merged in
  (`android/manager`).
* **Third-party addon sources are not vendored code.** `addon-sources.json` lists
  where the *other* clients publish their plugins and themes (Aliucord, Revenge,
  Vendetta, Bunny, Vencord, Equicord, BetterDiscord, Replugged) so the browser can
  find and open them. It is a map of other people's catalogues, not a copy of their
  contents, and nothing from it ships in this client.

One gap, stated rather than implied: there is **no licence file at the root of this
repository**. `package.json` records `"license": "GPL-3.0-or-later"` and the two
upstream texts are kept verbatim under `vendor/`, but a `LICENSE`/`COPYING` file for
this work itself is not in the tree, and neither is the Android half's
`android/LICENSE` (see [the Android README](docs/ANDROID-README.md)).

## Layout

```
hypercord/
  package.json          electron, electron-builder and electron-updater
  src/main.js           the shell: one window, attachment, no tray, quits on close
  src/preload.cjs       the bridge, the settings entries, the one style element
  src/api.js            control-server client (Bearer token, never logged)
  src/plugin-host.js    manifest-driven host: lazy import, handles, settings, isolation
  src/themes.js         CSS-only themes: local, online-at-install, quick CSS, sanitised
  src/patcher.js        finding, patching, unpatching and launching a real Discord
  src/loader.cjs        what a patched Discord requires; injects into its windows
  src/updater.js        electron-updater, silent, installs on quit
  src/injected.css      the styles for what Hypercord injects into Discord's page:
                        the token option and the entries in Discord's settings
  src/prompt.html       the token option that sits under Discord's login fields
  src/passkeys.cjs      the one passkey policy: no prompt nobody asked for
  src/panes.html|js|css Hypercord's settings pages, mounted inside Discord's own
                        settings: commands, plugins, Hyper plugins, themes, logs,
                        accounts, access keys - one page each
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
rollback), the preload (theme style element, the token option, the entries in
Discord's settings, the pages mounted in Discord's content column) and the settings
UI (all seven pages, real data, no page errors).

Not yet true, and not claimed: the RSS budget in `PERF.md`, the vendored
catalogue's TypeScript plugin *bodies* (the host refuses a `.ts`/`.tsx` entry with
"TypeScript source, not built" rather than pretending - the upstream catalogue
needs its own build step to become loadable JavaScript), the served `/discord`
fallback, a signed installer, and the Android build.
