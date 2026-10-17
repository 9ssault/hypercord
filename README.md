# Hypercord

Our own Discord client, and when a real Discord is installed it *is* Discord: the
client patches the official desktop client to load Hypercord's loader (byte-exact -
`app.asar` is renamed, never rewritten) and starts it, so the client you chat in is
the actual Discord with our loader in front of it, not a window of ours showing the
web app. That is the default rather than a flag, because an install is a fact about
the machine: a packaged run with a Discord in front of it is that client. A machine
with no Discord installed, a development run, an install another loader owns, and
`--no-attach` all keep the Electron window instead - and the run says which of those
it is, on the Logs page's About block and in the shell's own log. The
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
| Updates are per app, and per install | Hypercord updates Hypercord: in a patched client the host runs inside Discord's own process, so the updater refuses (`mode: "foreign"`) rather than reading Discord's feed. A run with no installed copy to replace - a `deb`, a `tar.gz`, the portable exe - says so (`mode: "elsewhere"`) instead of failing in the dark |
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

Two paths, and which one a run is comes out of `src/attach.js`:

1. **The real client - what a run with an install does.** `src/patcher.js` finds the installed
   Discord (Windows `%LOCALAPPDATA%\Discord{,PTB,Canary}\app-<v>\resources`,
   macOS `/Applications|~/Applications/Discord{ PTB, Canary}.app`, Linux
   `~/.config/discord*/app-<v>/resources`, package roots and Flatpak), renames
   `app.asar` to `hypercord.app.asar` - never rewriting it, so unpatch is
   byte-exact - and writes a `resources/app` entry point that requires
   `src/loader.cjs` and then hands off to the real client. The loader injects one
   `<style>` element into Discord's own windows - the themes and the styles for the
   two pieces of Hypercord that live in Discord's tree - and nothing else.
2. **The fallback window.** No Discord installed, a development run, an install
   another loader owns, or `--no-attach`: `src/main.js` opens Discord web with the
   same preload, settings pages and plugin host. Every one of those answers is
   recorded with its reason, so a window that appears instead of the real client can
   say why it did.

Everything of ours lives inside Discord's own window: the token option under its
login fields, and Hypercord's settings as **pages inside Discord's own settings** -
one entry per section (commands, plugins, our own Hyper plugins, themes, logs,
accounts, access keys), added to Discord's own sidebar as a *copy* of one of its
sections: their heading, their rows, their classes, so the client's own stylesheet
and its theme lay the entries out and type them, and placed first in Discord's list
of sections so they are on screen the moment settings opens. A client whose sidebar
holds its rows itself gets the same entries beside them, wearing the class of the
row they were built beside. The pages open in Discord's settings content column.
There is no second window, no overlay rail and no sheet of our own to find or
raise; leaving Discord's settings leaves these pages with it.

### When Discord updates itself

Discord's own updater does not update an install in place: it unpacks a *new*
`app-<version>` directory and applies it at the app's next start, so nothing of
ours travels with it and the shortcut then starts a client with no Hypercord in it.
A patch is therefore a fact about one version directory, and it is re-applied per
version:

* every run that attaches patches the newest install if it needs it, and a run
  that started Discord watches it exit - the moment the staged update is applied -
  and patches the version that will start next;
* a patched client can ask for a refresh from inside itself (Logs → *Refresh the
  patch*), which is written to a request file and applied by the next run that
  attaches: a patched client cannot re-patch itself, because Electron read the entry
  point when that process started;
* the patch's own record says which build wrote it, what runtime it baked and a
  digest of those bytes, so a client standing on a patch from an older Hypercord can
  say so on the Logs page instead of looking healthy.

What this deliberately does not do is start anything or kill anything: a person who
closed Discord does not find it reopened, and a running client is never restarted to
pick a patch up.

## Setup

Prerequisites: Node on Windows, macOS or Linux (CI uses 20; `electron` 44).
`package-lock.json` is committed, so the release workflow installs with `npm ci` -
which is the point of it: a release builds the dependency tree the lockfile pins,
not whatever the registry serves that day. `npm install` is for *changing*
dependencies, and its lockfile edit is part of the change.

```bash
npm install
npm test              # every suite: units (node), then the electron ones
```

### Desktop - run it

```bash
npm start                     # with a Discord installed, patch it and start *that* as the client
npm start -- --no-attach      # the Electron window: Discord web + our preload
npm run perf                  # --perf=45: the same client, measures each process, quits
```

The five things we put inside a patched client - `src/injected.css`,
`src/prompt.html`, `src/panes.html`, `src/panes.css` and `src/panes.js` - are
*baked* into it at patch time: `src/patcher.js` writes them into the install's
`resources/app/hypercord.json` and `src/loader.cjs` reads them from there. Editing
one of them therefore needs `npm run dev:bake`, which writes the repository's
current copies into every patched client without re-patching anything else;
re-patching a client to pick up a paragraph of CSS is the step people stop doing.
`src/loader.cjs`, `src/attach-preload.cjs` and `src/preload.cjs` are different:
they are read from this repository live, when the client's window is created, so a
restart is all they need.

Attaching needs an installed Discord. `src/patcher.js` looks under Windows
`%LOCALAPPDATA%\Discord{,PTB,Canary}\app-<v>\resources`, macOS
`/Applications|~/Applications/Discord{ PTB, Canary}.app`, Linux
`~/.config/discord*/app-<v>/resources`, package roots and Flatpak. It renames
`app.asar` to `hypercord.app.asar` (never rewritten, so unpatch is byte-exact)
and writes a `resources/app` entry point that requires `src/loader.cjs`. A
`resources/app` that is not ours, and a directory that is not a Discord install,
are left alone and refused rather than touched. With no Discord installed, the
Electron window *is* the client, and nothing of ours starts at boot or stays
resident: closing the window ends Hypercord.

The same command works on all three platforms - `npm start`, or `npm start -- --attach`
to say it out loud - and only the paths and the way the client is started differ:

| Platform | Where the install is found | How it is started |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Discord{,PTB,Canary}\app-<v>\resources`, newest version first | that install's own `Discord.exe`, detached |
| macOS | `/Applications` and `~/Applications`, `Discord{ PTB, Canary}.app`, version from `Contents/Info.plist` | `open -a <the bundle>` - the path, never the name, so the copy that opens is the one that was patched |
| Linux | `$XDG_CONFIG_HOME` (or `~/.config`)/`discord{,ptb,canary}`/`app-<v>/resources`, the package roots and Flatpak deployments | the binary inside the install, or `flatpak run <app-id>` for a Flatpak one |

Stable is preferred over PTB and Canary on every platform, a `resources/app` that is
not ours is refused rather than touched, and `tests/patcher/index.mjs` runs the whole
patch/unpatch round trip on each of the three layouts. [PLATFORMS.md](PLATFORMS.md) has
the detail, plus the one honest gap: no run against a real macOS or Linux Discord
install is recorded anywhere in this repository.

An update is a property of an *install*, not of the way the client is run: inside a
patched Discord the code comes from the tree the patcher pointed at (the loader and
the preload are read from it live, as above), so that copy is updated by updating the
tree, and this is why the updater refuses in Discord's own process rather than
driving an installer for somebody else's app. An installed Hypercord updates itself,
per platform and per artifact, exactly as the build table below says.

### Desktop - build it

```bash
npm run vendor        # merge + rebrand the vendored catalogue into plugins/manifest.json
npm run vendor:check  # the same audit, read-only
npm run pack          # electron-builder --dir -> dist/win-unpacked (or the platform equivalent)
npm run check:packaged -- --fresh   # start the packed exe and read its page
npm run dist          # the installers, into dist/
```

#### What a clean clone has and does not have

`git clone` + `npm ci` is enough to build this client, with one exception that is
worth knowing before it bites: `vendor/equicord` and `vendor/vencord` are recorded
as gitlinks and this repository has no `.gitmodules`, so a fresh clone gets those
two paths **empty**. What that means, in order:

| Command | On a clean clone |
| --- | --- |
| `npm ci` | works: `package-lock.json` is committed, and nothing in the desktop client needs the vendored forks |
| `npm run test:units` | works, all suites: the catalogue the client ships is `plugins/manifest.json`, which *is* committed - `npm test` walks that file rather than the forks |
| `npm run build:runtime:check` | works, and answers anyway: it reports the committed runtime as current and names the commits it was baked from (`Equicord 3cf8161e…, 2528kb from vendor/runtime/browser.js - the committed copy`), which is exactly what a checkout without the forks can check |
| `npm run pack` | works, checked on a clean clone: `electron-builder --dir` packs `dist/linux-unpacked` (or the platform equivalent) and the packed `app.asar` carries `vendor/runtime/browser.js`, which is committed |
| `npm run dist`, `npm run release` | the same commands as always, from the same clean tree; each platform's toolchain is the only extra thing they need, and `release` also starts the packed exe, so it wants a session (`xvfb-run` on a headless Linux box) |
| `npm run vendor`, `npm run vendor:check` | **refuse**, naming both paths and what to do about them - `FAIL no vendored core at vendor/equicord - clone it first` and the same for `vendor/vencord` - exit 1, nothing written |
| `npm run build:runtime` | stops with `the vendored tree has no build to run (vendor/equicord)`: the runtime is built *from* the forks (`vendor/equicord` as the base, Vencord merged in) |

So if you are only building and running the client, clone and go. If you are
generating the catalogue or the runtime - `npm run vendor`, `npm run build:runtime`
- clone your checkouts of Equicord and Vencord into `vendor/equicord` and
`vendor/vencord` first. Which commits this tree was last built from is recorded, not
guessed: `plugins/manifest.json` carries `provenance.coreCommit` and
`provenance.mergedCommit`, `npm run vendor` re-records whatever you cloned, and
`npm run build:runtime` names the commits it baked into `vendor/runtime`.

`build` in `package.json` decides what each platform gets:

| Platform | Targets | Artifact names in `dist/` |
| --- | --- | --- |
| Windows | `nsis` setup + `portable`, x64 and arm64 | `Hypercord-<version>-win-<arch>-setup.exe`, `...-portable.exe`; one `latest.yml` serves both architectures, and the `nsis` install is what updates |
| macOS | `dmg` + `zip`, x64 and arm64 | `Hypercord-<version>-mac-<arch>.dmg`, `....zip`; `latest-mac.yml` lists both architectures as `zip`s and the updater takes the one that matches the machine |
| Linux | `AppImage` (x64 and arm64), `deb` and `tar.gz` (x64) | `Hypercord-<version>-linux-<arch>.AppImage`, `....deb`, `....tar.gz`; the AppImage self-updates through the channel file for its architecture (`latest-linux.yml`, `latest-linux-arm64.yml`), a `deb` or a `tar.gz` is updated by whoever installed it |

One run can do several targets: `npm run dist -- --win --linux --x64`.
**Signing is not configured in this tree** - there is no certificate, notarisation
or `CSC_*` step, so macOS and Windows artifacts are unsigned; macOS will warn on
first open, and Gatekeeper refuses an unsigned replacement, so a macOS build must
be signed for the silent updater to install into it. Building macOS artifacts
needs macOS; Windows and Linux artifacts can both be produced from either. What
self-updates from the feed is narrower than what is built: the Windows `nsis`
installer and the Linux `AppImage` do, a macOS build only once it is signed and
notarised, and a `deb`, a `tar.gz` or the portable Windows exe never - none of those
is an installed copy of ours for an update to replace, and each such run says so in
its update row rather than failing silently.

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
under Discord's Settings under the Hypercord entry.

Toolchain, with the reason each number is that number - a toolchain list without
one is a list somebody "fixes" downwards: **JDK 21** (`android/manager/build.gradle`
sets `sourceCompatibility JavaVersion.VERSION_21`; `android/loader` compiles at 17,
so 21 builds both. `scripts/build_android.py` reads the version of the `java` on
`PATH` before Gradle starts and refuses an older one by name, because Gradle's own
answer for it - `invalid source release: 21` - arrives after a minute of other
tasks and reads like a source error), **Android SDK platform android-36 and
build-tools 36.0.0** with `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) set (both modules
are `compileSdk 36`; AGP fetches a missing platform itself once the SDK licences
are accepted), and **Python 3.9+** on `PATH`, because the loader's `runtimeAssets`
task runs `scripts/patch_runtime.py`. Gradle is the repository's own wrapper
(`gradlew` / `gradlew.bat`, pinned to 8.13 in
`gradle/wrapper/gradle-wrapper.properties`, with AGP 8.11.1 declared once in the
root `build.gradle`), so there is no system Gradle to install. The interpreter is
found rather than assumed - `python3`, then `python`, then `py -3`, each one *run*
and asked for its version - so a Windows box that only has `python` is fine, and
the Microsoft Store's `python3` alias is deliberately not accepted: it is on
`PATH`, it fails when it runs, and its complaint mentions Python.

```bash
python scripts/build_android.py                 # the manager, release variant
python scripts/build_android.py --all-variants  # manager and loader, release
python scripts/build_android.py --variant debug # a debug build, unsigned
python scripts/build_android.py --dry-run       # the plan, nothing run
```

`--modules manager,loader` builds a subset, `--output-dir` moves the copied
candidates (default `release/candidate`), and each APK is left where Gradle put it,
`android/<module>/build/outputs/apk/<variant>/`. Every run writes
`release/acceptance.json`: what was built with its size and SHA-256, and - under
`checks_not_run` - what was *not* checked, which is where an unsigned artifact says
so instead of passing for a signed one.

The one thing a release build refuses without is signing material.
`android/signing.gradle` reads `HYPERCORD_KEYSTORE_PATH` and
`HYPERCORD_SIGNING_PASSWORD` (with `HYPERCORD_KEY_ALIAS`, default `hypercord`, and
`HYPERCORD_KEY_PASSWORD`, defaulting to the signing password), and without them it
stops before any release work unless `HYPERCORD_ALLOW_UNSIGNED=1` asks for an
unsigned release on purpose. That second one is a decision, not a shortcut, and
the log says which happened: an unsigned APK installs, cannot update over an
install signed with another key, and must not be published.

Both modules build with exactly this and nothing else: the LSPatch code the manager
patches with is `android/deps/lspatch.jar`, its icon and backup rules are
`android/branding/res`, and neither needs a jar staged by hand. Nothing on the way
is fabricated either - the loader's task copies the pinned upstream runtime,
splices in the reviewed patch text, renames the display strings it finds, and
**fails** when one of them is missing rather than shipping a half-rebranded
bundle, and `scripts/build_android.py` inspects each APK it copies before it is
recorded.

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
  first run. The page that browses them is the familiar one - a grid of cards, a
  switch on each card, a plugin's own settings behind its name - and the
  categories are the tags upstream declared for each plugin, counted and offered
  as chips (`Utility 133`, `Chat 105`, ...) beside the search box.
  * **Two names for the same plugin.** The catalogue keys an entry by the
    directory its source lives in (`accountPanelServerProfile`); the built
    runtime keys the plugin, and its settings, by the plugin's own name
    (`AccountPanelServerProfile`). Every lookup goes through that mapping
    (`runtimeKeyFor` in `src/panes.js`, `runtimeKeysFor` in `src/loader.cjs`),
    measured against the built bundle's own 372 keys: 345 of the 371 catalogue
    entries are in this build, and the 26 that are not (platform variants like
    `.desktop`, `.dev`, `.equibop`) say **not in this build** on their card rather
    than blaming the window they are shown in.
  * **One owner per switch.** The vendored catalogue is TypeScript source this
    process cannot load, so the built runtime inside Discord's page is what runs
    those plugins, and its own settings are the live answer to "is it on". That
    store cannot keep anything - Discord's own page removes `localStorage` and
    `sessionStorage` (measured), so a flag written there is forgotten on the next
    start - which is why the *record* of the choice lives in
    `plugins.state.json` (`src/plugin-host.js`) and `src/loader.cjs` hands it to
    the runtime as the settings it starts from. A card, the runtime and the host
    therefore read one thing rather than three copies of it, and the host never
    claims to have started a plugin the runtime is running.
  * **A plugin that patches Discord while it loads** cannot be switched in a page
    that is already up. Its card says `restart to apply` instead of `running`,
    the record is written first so the next start honors it, and the Plugins page
    carries a **Restart** button (`client:relaunch` in `src/host.js`) so the
    restart it needs is one press there rather than a hunt for the tray icon. It is
    offered only while something is actually waiting - the reading is the runtime's
    own "cannot switch live" plus the record disagreeing with what the page is
    doing - and it says what: the label counts it and the tooltip names it, and the
    summary under the filters says it too. With nothing waiting the button is
    disabled rather than asking for a restart that would apply nothing.
  * **Settings of a vendored plugin** are the plugin's own and are drawn by the
    runtime that owns them: the card's cog opens that window rather than a form
    assembled here, and a plugin that declares nothing gets no cog at all.
  * **Hypercord's own pages are files on disk**, but not files the client reads
    back: `src/panes.html`, `src/panes.css` and `src/panes.js` are handed to a
    patched client as baked assets (`npm run dev:bake`, see *Desktop - run it*
    above), because the loader is what carries them into Discord's page. A change
    to them therefore needs a bake **and** a restart - by far the commonest
    "my edit did nothing" in this tree. A restart is also what every plugin that
    patches Discord while it loads needs, which is the case the **Restart** button
    exists for.
* **Themes.** Local `.theme.css` files, online themes by URL (fetched once, at
  install time) and quick CSS, all through the one injection point in
  `src/themes.js` - plus the published theme library, read when somebody presses
  Load and trimmed to what a card shows. A theme installed from the library is
  fetched once through the same door as a pasted URL, so there is one install
  path, one sanitiser and no second code path to audit.
* **Sources.** `addon-sources.json` is the catalogue of plugin and theme sources
  other clients publish - Aliucord's `manifest.json`, the Vendetta and Bunny
  plugin proxies, Revenge's `index.json`, Equicord's `Equibuilds` JSON, plus the
  browseable Vencord, BetterDiscord and Replugged listings - and
  [docs/addon-sources.md](docs/addon-sources.md) says what each one returns and
  how to fetch it. The limit is honest: those plugins are written for *their*
  runtimes. This client installs only its own addon dialect (the bounded
  interpreter in [docs/addon-framework.md](docs/addon-framework.md): `.js`/`.txt`,
  no loops, imports, async or prototype access). A TypeScript *body* is not
  something the host can load at all: the vendored catalogue's are run by the
  built runtime (above - the host records the switch and the loader hands it
  over), and anything else arriving from one of these catalogues has to be in
  this dialect to be installable. Sources are for browsing and fetching; what
  installs has to be in this dialect.

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
  src/attach.js         which client a run is (real Discord vs this window), and what
                        to do about an install Discord has moved on from
  src/tokens.js         the user-token store: in the OS keychain, never in a log
  plugins/hyper/        the five Hyper plugins, and the set that is on by default
  plugins/manifest.json 371 entries of metadata: what the manager reads
  vendor/equicord       the vendored upstream core (GPL-3.0, licence kept verbatim)
  tests/                node: plugin-host, themes, patcher, attach, tokens, signin,
                        bridge, release, loader, host, beef, shipped; electron:
                        updater, preload, baseline (see Tests)
  PERF.md               the budget and the real readings
```

## Tests

```bash
npm test              # units, then the electron suites, in one go
npm run test:units    # node: plugin-host, themes, patcher, attach, tokens, signin,
                      # bridge, release, loader, host, beef, shipped
npm run test:electron # electron: updater, then preload, then feed-live
npm run test:preload  # the injection path in a real window
npm run test:updater
npm run test:feed-live # the update loop, on a packed build and a feed of ours
                      # (needs `npm run pack`, or the installers, first: with
                      # neither it reports SKIPPED and exits 0)
npm run test:baseline # electron tests/baseline --perf=25: the RSS budget
```

The electron suites need Electron and no display - every window they open is
`show: false`. `test:preload` is the slow one, about a minute: it loads a dozen
real windows (each a page standing in for Discord's, or a shape a release serves
instead) and gives each one time to settle, because the things it checks - where a
page lands, where a point inside it lands, which rows the entries wear - are
answers the layout has to produce first.

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

Not yet true, and not claimed: the RSS budget in `PERF.md`, the served `/discord`
fallback, a signed desktop installer, an update installing into an unsigned macOS
build, and a *signed* Android APK - both Android modules
build and produce APKs, but every one built so far is unsigned (see
[docs/android-build.md](docs/android-build.md)), so nothing here is published.
