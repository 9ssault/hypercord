# Changelog

What changed in this repository, newest first. One file, because there is exactly one product
here: the client, the vendored runtime it ships, and the plugins and themes both halves run.

This file is *not* the runtime's own changelog screen. That screen (the runtime's Changelog tab)
reads commit history from the repository the vendored tree came from and says so in the page;
what is written here is this client's own record.

## Unreleased

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
