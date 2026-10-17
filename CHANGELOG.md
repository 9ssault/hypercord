# Changelog

What changed in this repository, newest first. One file, because there is exactly one product
here: the client, the vendored runtime it ships, and the plugins and themes both halves run.

This file is *not* the runtime's own changelog screen. That screen (the runtime's Changelog tab)
reads commit history from the repository the vendored tree came from and says so in the page;
what is written here is this client's own record.

## Unreleased

- A push or a pull request now checks the tree **as a fresh clone gets it**
  (`.github/workflows/check.yml`): install from the lockfile, the unit suites, the runtime and
  addon audits, and the contract that the commands needing the vendored forks refuse with a
  sentence naming the path to clone rather than dying with a stack trace about a missing file.
  Both failure modes that motivated it were invisible in a working tree - `npm run vendor:check`
  crashed on a clean checkout because its guard tested the directory (a checkout with the
  gitlinks uninitialised has the directory, empty), and a token-shaped test fixture made
  GitHub's push protection refuse the push. The Electron suites stay where they are, in the
  release gate, on runners with a display - so the half of the sheet/vs-preload contract that
  only ever needed a window is checked in plain node instead: every `hc.<group>.<method>` the
  settings pages call is read off `src/panes.js` and matched against the api `src/preload.cjs`
  exposes, which turns "a button that throws a TypeError on click" into a failing suite.

## 0.3.12

### The Restart button works, and the gate that hid it says what it saw

Three things were red on every platform, and the release pipeline reported none of them.

- **The Restart button in the settings pages works.** `src/preload.cjs` builds one bridge object
  and it carried `client:` **twice** - `relaunch` in the first, `info` and `reapply` in the second.
  A repeated key in an object literal is not an error, it is the last one winning, in silence, so
  the page got `client.info` and `client.reapply` and no `client.relaunch`: pressing Restart
  answered "this client has no way to restart itself: close it and open it again" in a client that
  has one. The two groups are one group now, and the suite fails if a key is ever repeated.
- **A window suite that ran and failed is no longer read as "cannot run on this runner".** Every
  Linux log carries dbus warnings, and "Failed to connect to the bus" was on the list of reasons
  that mean "this runner cannot open a window" - so a suite that ran and failed its own assertions
  was classified as *skipped* on Linux while Windows and macOS failed the job over the same two
  lines. That is why 0.3.10 shipped with a red preload suite that nobody saw. A verdict the suite
  printed itself (`passed 184  failed 2`) now outranks that list; the list still decides for a
  suite that never reached a verdict.
- **The theme library's contract is written down as it is.** Opening the Themes tab reads the
  published index once, Load forces a fresh read, and nothing is fetched for a tab nobody opened.
  The suite now asserts exactly that - no read before the tab is drawn, one unforced read as it is
  drawn, and one forced read when Load is pressed - instead of asserting a rule the code stopped
  following when the tab became the library's browser in 0.3.10.

## 0.3.11

### A failed platform no longer takes the whole release down with it

No product change: the same client as 0.3.10, with the release pipeline fixed where it was
refusing to publish.

- **A release publishes everything that built, and stays red about what did not.** The publish
  job's feed check refused the whole release whenever a platform's channel file was missing -
  including when that platform had simply built nothing, which is how a run with a healthy Linux
  build, a failed Android build and a failed Windows suite published no release page at all. A
  feed missing because its platform never built is now reported by name (`NOTE latest.yml is
  missing because nothing was built for win in this run`) and the artifacts that did build are
  attached; a feed that names an artifact which is not in the release, or a feed whose version
  disagrees with `package.json`, is still refused. The run fails either way - *Fail if any platform
  that was asked for did not build* is what says which platform it was.
- **A release can be started from git alone.** Pushing a branch named `release/vX.Y.Z` (whose
  name must match the version in `package.json`, exactly as a tag must) runs the same pipeline as
  a tag push and lets the publish job create the tag itself, from the commit the run built. A push
  made with the workflow's own token does not start another run, so creating the tag cannot
  re-enter the pipeline; a tag that already exists is refused rather than reused. The tag push and
  the manual dispatch work exactly as before.
- **Each platform's suite logs travel under its own name** (`suite-preload-windows.log`,
  `suite-preload-macos.log`, `suite-preload-linux.log`). Three jobs upload a log of the same name
  into one directory on the release page, so the platform that *failed* could be the one whose log
  was overwritten by a platform that passed - which left exactly one copy of the evidence, and it
  was not the failing one.

## 0.3.10

### Three fixes that were waiting to ship

- The sign-in token prompt now only ever appears on Discord's logged-out login form: storing a key from inside settings (or anywhere past the login screen) can no longer summon a modal on top of the signed-in client.
- A Hypercord settings entry that cannot be placed says so in a notification, not just the shell log: a click that moves the highlight and opens nothing no longer reads as the settings being broken with no reason given.
- A plugin's boolean settings save the value they show: the switch used to keep the state it was drawn with, so two clicks saved the same value twice while the knob never moved - it now flips with the press and only steps back if the save is refused.

### The real client is the default, and it survives Discord updating itself

- **A run with a Discord install now patches it and starts it without a flag.** `--attach`
  still works and still says it out loud; `--no-attach` is the way to ask for this shell's own
  window. Which of the two a run is comes out of `src/attach.js` rather than out of the argument
  list, and the answer is recorded with its reason either way - on the Logs page's new About
  block and in the shell's own log - because a window that appears instead of the real client is
  otherwise indistinguishable from a client that failed to start.
- **A run a harness started never attaches.** The electron suites, `scripts/check-packaged.mjs` and
  `npm run perf` start a build with `--perf`, `--remote-debugging-port=…` or `--user-data-dir=…`,
  and a packed build that answered those by patching and launching the Discord installed on the
  machine would both break the check and touch a machine it was never asked to touch. Those three
  switches now mean "this run is not somebody's client" and are named in the reason, alongside the
  `--no-attach` the two packaged harnesses now pass themselves.
- **Discord's own updater no longer silently unhooks the client.** It installs a new
  `app-<version>` directory instead of updating the one it had, so nothing of ours travels with
  it. A run that attaches now patches the newest install if it needs it, a run that started
  Discord watches it exit - the moment a staged update is applied - and patches the version that
  will start next. A patched client can ask for a refresh from inside itself, which is written as
  a request and applied by the next run that attaches (a patched client cannot re-patch itself:
  Electron read its entry point when that process started). Nothing is ever started or killed to
  make this happen.
- **A patch that is behind says so.** The patch record now carries `patchedByVersion` next to
  Discord's own `version`, the version and a digest of the runtime it baked, and the platform and
  Electron/Node versions it was made on - so a client standing on a patch from an older Hypercord
  reports it as stale (with the numeric comparison that `0.3.9` vs `0.3.10` needs) instead of
  looking healthy. Refreshing an existing patch rewrites the record and the baked stylesheet,
  and never blanks assets a previous patch put there.

### Which client this is, and a file to send somebody

- The Logs page opens with an **About this client** block: the process this host is inside, which
  Discord it stands in front of, which version, what the patch recorded (and whether it is
  current), and every install found with its patch state. It is read from this process, so it
  answers with no control server and no network, and a fact the shell cannot answer is said as
  unknown rather than left blank.
- **Save a support bundle** writes one text file with all of that plus the stores' state and this
  host's own log, through `redact` with every stored secret supplied. A stored key never appears
  in it, in any form; the file says in its own header what it deliberately leaves out.

### The theme library is a browser now

- Opening the Themes tab reads the published library once (the service caches its own reply, so a
  second visit costs no request), and the list has its own **filter by kind**, **order by**
  downloads, likes, age or name, and a search box. The kinds come from the index itself, and an
  order or kind that would only ever produce an empty page is not offered.
- A card can show a **preview**: the picture is fetched by the shell and drawn from a data URL,
  never hotlinked, because the image policy in Discord's page is Discord's - one request for the
  one preview somebody asks for, cached for a handful, capped in size, https only, and refused
  with the host named when it is a host this client does not fetch.
- The library's read is now guarded: a second failed read keeps the list already on screen rather
  than blanking two hundred cards.


## 0.3.9

### The release the failed gates held back

No product change since 0.3.8: this is the same client, with the two suite failures
that kept 0.3.8 to a Linux-only release fixed. The selection test closed the sheet
it had just asserted on, and a field in a closed page cannot take focus - so the
caret tests measured a hidden subtree; the sheet is reopened first now. And the
sandbox decision's no-facts check read the real machine, failing wherever the room
set `ELECTRON_DISABLE_SANDBOX=1` itself - it asserts the decision's shape instead.

## 0.3.8

### Enter signs in with a pasted token

The token option's form swallowed Enter: its submit handler only prevented the
default and never stored anything, so only the button signed in - and on a small
screen that button can be out of reach entirely. The submit is the one way in now:
Enter in either field and the button both store the pasted token and sign in with
it, exactly once.

### The plugin cards lost their broken pictures

Every card in the runtime's plugin browser wore a broken-image placeholder: the
per-card source badges are pictures of equicord.org, and Discord's page refuses
them under its content-security policy before they load. They are decorative, so
a picture that cannot arrive is put away - scoped to those badge URLs, so a theme
preview from anywhere else keeps loading.

## 0.3.7

### The window is only the client

Electron's default menu - File, Edit, View, Window, a second way to quit and a
reload that fights the client - is gone (`win.setMenu(null)` in `src/main.js`).
A chat client has nothing to put in those menus, and the page already owns every
shortcut it needs.

### The open entry reads as open

Discord paints its settings rows' selected box from React, which does not know the
rows this client adds - so every Hypercord entry below the runtime's own read as
unselected, whatever page was showing. The preload now marks the open entry itself:
it learns the selected look from a natively selected row (never assumed, the class
names are generated per release), clears every other row first, hands the box back
when one of Discord's own sections is chosen, and re-marks across rebuilds.

### The Linux shell stops asking the sandbox for what it cannot give

On kernels that refuse unprivileged user namespaces the AppImage's setuid helper
cannot work, and Chromium's helper processes then die at birth while the main
process looks healthy. The shell now launches with `--no-sandbox` where the
sandbox cannot work anyway - as root, with `ELECTRON_DISABLE_SANDBOX=1`, and
inside an AppImage - decided by `src/linux-sandbox.js`, applied in `src/main.js`
before anything can spawn a helper, with the reason logged. Only the OS-level
sandbox is off; the window keeps `sandbox: true`. `HYPERCORD_SANDBOX=0` keeps the
sandbox everywhere, and `tests/linux-sandbox/index.mjs` covers the decision.
What this does *not* fix is a broken FUSE mount: `--no-sandbox` changing nothing,
a `SIGBUS` for the app in `coredumpctl`, and an extracted payload that runs fine
mean the mount, not the sandbox - `APPIMAGE_EXTRACT_AND_RUN=1` or the `deb` and
`tar.gz` from the same release, which never touch FUSE. See `PLATFORMS.md`.

## 0.3.6

### The cloud tab can reach its backend again

Every request the vendored runtime makes to its cloud backend was made by the *page*, and the
page is Discord's: its content-security policy refuses an origin it does not name. That is what
`Setup failed (couldn't retrieve OAuth configuration)` was - not a backend that was down, but a
request that never left. The request is made by the shell now: `runtime:request` in `src/host.js`,
reached through `window.hypercord.runtime.request` (`src/preload.cjs`), with
`vendor/equicord/src/api/SettingsSync/cloudRequest.ts` serving the runtime's own `fetch` and
`cloudSetup.tsx`/`cloudSync.ts` calling it - the OAuth handshake, the manifest, every sync, the
deletes.

It is deliberately not a general proxy: only https, only the origin the client's cloud tab is set
to (the two defaults, plus whatever `runtime.settings.json` names, read per request so a
self-hosted backend works), a 20-second ceiling and an 8 MiB answer cap, and a *named* refusal
for anything else. Bodies travel as bytes in both directions: the synced settings are deflated
before they are uploaded and inflated after they are fetched, so a body read as text would arrive
corrupted and fail as "settings could not be imported". `tests/host/index.mjs` asserts the
boundary - who may be asked, the refusal wording, the bytes.

### An update belongs to an install, not to a process

Three ways the updater could do the wrong thing, all of them now stated instead of silent. It
refuses to run in a process that is not Hypercord's (`mode: "foreign"`: in a patched client the
host runs inside Discord's own main process, where `app.isPackaged` is true and `resourcesPath`
are Discord's, so it would otherwise read *Discord's* updater configuration and could quit
Discord to run an installer for it), it refuses when there is no installed copy to replace
(`mode: "elsewhere"`: Linux without `APPIMAGE`, and the portable Windows exe), and the reason
travels as `state.note` into the update row of the settings page - "not updating in this run"
on its own was the silence those two cases deserve to lose.

The third is a real bug, measured on a packed build rather than reasoned about: electron-updater
reads a *config* file (`app-update.yml` in resources) for its download cache directory no matter
which feed it was given, so a build that shipped none found the update - `update available: 0.3.6`
in the log - and then failed the download with `ENOENT ... app-update.yml`, which reads exactly
like a broken feed. A feed override now writes the config it needs beside the client's own state
and points the updater at it.

That bug is covered by a suite rather than by hand now: `npm run test:feed-live` starts the packed
build with `HYPERCORD_UPDATE_FEED` pointed at a local feed offering a version it does not have,
reads the client's *own* update state until it reports the download, and ends the client before
anything can install. Every desktop job of the release workflow runs it after the installers,
because the failure it covers exists only in an artifact, and a runner with nothing to drive says
`SKIPPED` instead of passing quietly.

### A feed per platform, and per architecture

`electron-updater` names the channel file it asks for, and on Linux it names it per architecture
(`latest-linux.yml` on x64, `latest-linux-arm64.yml` on arm64 - `getChannelFilePrefix()`), while
`app-builder-lib` writes those names the same way. The release advertised an arm64 AppImage and
built Linux for x64 only, so every arm64 install asked for a file that was not on the release and
never updated, silently. The desktop matrix builds `--linux --x64 --arm64` now and uploads
`dist/latest*.yml` rather than three fixed names, and the publish job runs
`scripts/check-feed.mjs` before the release page exists: every feed is read, and the release is
refused when one names an artifact that is not attached, when a feed the build config promises is
missing, or when a feed's version disagrees with `package.json`. `tests/release/index.mjs` covers
the reader and the three refusals.

`scripts/check-packaged.mjs` ends the packaged app by *process group* on Linux and macOS now
(`detached` at spawn, `process.kill(-pid)`), because Electron's renderer and GPU children are
processes of their own: ended by pid alone they survived the check and held the throwaway
profile. PLATFORMS.md and README.md say what each platform's artifacts actually do about
updates, including the two that never self-update (`deb`, `tar.gz`) and the one that cannot
install one unsigned (macOS).

### The tree stops showing its own builds

`release/`, `.gradle/`, the Android modules' `build/` directories and `build/reports/` are build
output and are ignored now, while `build/` itself stays tracked because the icons and
`build/README.md` are electron-builder's inputs. `tests/runtime-playtest/` was a throwaway probe
(its header said so) whose answer is recorded in the runtime store's comments, so it is gone;
`tests/shipped/` - a real suite that `npm test` already runs - and the hand-written `CHANGELOG.md`
and `.coderabbit.yaml` are tracked.

### The runtime's name is Hypercord now

The vendored core's display strings say Hypercord: the settings section and its panel titles
("Hypercord Settings", "Hypercord Updater", "Hypercord Cloud"), the about tab, the console
banner, the plugin and theme manager's own copy, the command palette's section labels and the
support helper's menu items.

Where the rename happens is the part worth knowing: it is done by `scripts/vendor.mjs`, not by
hand. The rebrand pass was already there for the desktop half (`src/main` + `package.json`);
it now covers the client's own chrome as well, because the heading a person actually reads -
"Equicord Settings" in Discord's settings list - is drawn by the *renderer*, so a rebrand that
stopped at `src/main` left the one string that mattered wearing upstream's name. `npm run
vendor` applies it, `npm run vendor:check` audits it, and a leftover display string in an
eligible file fails the audit rather than being a matter of taste.

What the pass deliberately does not touch, and why:

* **Attribution.** The credits, the licence, the `GPL` headers and the upstream links are
  untouched - that is the licence's condition, not a preference. The vendored tree keeps its
  provenance in `plugins/manifest.json` too.
* **Other people's names.** Badges, the donor list, the hall of fame and the platform tags that
  describe somebody else's client are about the person or the project they name. Renaming one
  would not be a rebrand, it would be a claim about them.
* **Identifiers and paths.** `retainEquicord`, `generateEquicordPluginJson`, `EquicordData`,
  `src/equicordplugins/`, the plugin ids, the data directory and every upstream URL stay exactly
  as they are: renaming those breaks the build, the update path or somebody's installed data,
  which is not what a display name is worth.

The settings entry our pages appear under follows the runtime's own heading, so a runtime that
draws any of its three spellings (Hypercord, Equicord, Vencord) brands our rows with the name
that is already on screen, and a rename does not leave two names for one thing.

### One settings section, one plugin tab, one themes tab

Our pages are no longer a section of their own beside the runtime's. In a client whose runtime
draws its own settings section, they are rows *inside* it - same list, same row markup, nothing
copied from a row that is Discord's - so the way in wears the name the client already shows and
there is no second place holding the same kind of thing.

Two pages are not offered as rows there, because that section already offers them: the runtime's
own browser of its own plugins, and its own list of themes. The pages themselves stay, reachable
by name, and keep what those rows do not (the catalogue with its switches, and the theme folder
and quick CSS beside the theme list). Every row we do offer is one of the sheet's own pages, and
each wears a mark of its own in Discord's icon slot - line art drawn in `currentColor`, so the
theme paints it and hover and focus look like the rows beside it - rather than the glyph of the
row it was copied from, or an empty slot that reads as a row that failed to draw.

### The themes tab, and what stays behind it

In a client whose runtime draws its own settings section, the Themes *row* of ours is no longer
offered there: that section already has the runtime's own themes row, and two rows wearing the
same name for the same kind of thing is what the merge exists to remove. The Themes *page* is
unchanged and still whole - the runtime's own theme tab when the window has one, and Hypercord's
own theme folder, install box, published-theme library and quick-CSS editor as the half that
knows about themes the runtime does not (which is also the half a client with no built runtime
falls back to). It was removed for a while during this work and is back: the browser is part of
what this client ships, not a duplicate of the runtime's list.

### A page that was drawn but not reached

The page's height inside Discord's settings layer is measured now instead of guessed. Discord's
own settings content is a positioned child of that same layer, so a page with a lower `z-index`
than it is *visible* and *dead*: every click lands on the client behind it. The number is one
more than the highest the layer actually has, which keeps the page above the screen it stands in
and below the client's other layers (modals, popouts). On top of that, the page asks where a
point in its own rectangle lands once it is placed: if something else inside the same layer is in
front of it, the page is raised above that too, and if it is still covered the client says so in
its log, with the element, its position and its z-index - because that failure has no error in it.
A layer that moves a fixed page is no longer a reason to leave the page at document level (where
the client's own modals open behind it): the page is placed inside that layer in the layer's own
coordinates instead.

### `build:runtime` shipped a bundle it had not built

The script ran the vendored *desktop* build and then copied `dist/browser/browser.js` - the
*web* build's output - into `vendor/runtime/`, which is the file `src/loader.cjs` injects. The
copy was therefore always the previous browser build: changes to the vendored sources never
reached the client, however many times the script ran, and nothing said so because the file that
was copied really did exist. It now runs the build that produces the file it ships
(`scripts/build/buildWeb.mjs`), keeps the desktop build as the fallback for a tree without one,
and reports which build it ran.
