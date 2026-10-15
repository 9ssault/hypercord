# Platforms

Hypercord is an Electron app, and Electron is a desktop runtime. That decides
what each platform gets - stated plainly rather than promised:

| Platform | How it ships | Notes |
| --- | --- | --- |
| **Windows** | `nsis` installer + portable exe, x64 and arm64 | the primary target; `electron-updater` installs the next release on quit. One `latest.yml` serves both architectures (the updater takes whichever listed installer matches the machine), and the **`nsis` install is what updates**: the portable exe has no installed copy to replace |
| **Linux** | `AppImage` (x64 and arm64), `deb` and `tar.gz` (x64) | the AppImage self-updates through the feed, with a channel file per architecture (`latest-linux.yml` on x64, `latest-linux-arm64.yml` on arm64); a `deb` or a `tar.gz` is updated by whoever installed it |
| **macOS** | `dmg` + `zip`, x64 and arm64 (Apple Silicon) | the `zip` is what the updater consumes and `latest-mac.yml` lists both architectures, so a machine takes the one that matches it; signing/notarisation needs an Apple developer identity, so an unsigned build warns on first open **and cannot install an update** |
| **Android** | **not Electron, and not built.** Today: the client is served by the control server (`/discord`) and installed from the browser as a PWA, or wrapped as a TWA with `bubblewrap`/PWABuilder using `pwa/manifest.webmanifest`. The APK path (a manager that patches a Discord APK, the shape Revenge Manager and Aliucord Manager use) exists as **sources only**: `android/manager/` and `android/loader/` hold the Java, the manifest and the assets, but the tree has no Gradle wrapper, no `build.gradle`/`settings.gradle` and no `scripts/build_android.py`, so **no APK can be produced from this checkout** - the CI workflow that expects those scripts cannot run here either. Sources present is not the same as an artifact, and none is claimed | Electron cannot run on Android. `rea` is an analysis toolkit, not a patcher, and this machine has no APK, Android SDK or JDK 25, so no APK is claimed |
| **iOS** | same served client, added to the home screen as a web app | no Electron, no sideloading story worth claiming |

## Auto-update

`src/updater.js` uses Electron's own updater through `electron-updater`, and it is
**silent by design**:

* a **development run never updates itself** (`app.isPackaged` is false, so the
  updater says so and stops) - otherwise a working tree would be replaced under
  you;
* a **process that is not Hypercord is never updated by Hypercord**. In a patched
  client the host runs inside Discord's own main process (`startHost` in
  `src/loader.cjs`), where `app.isPackaged` is true and `process.resourcesPath` are
  Discord's - so the updater first checks that the running app *is* Hypercord
  (`ownName`, taken from `app.getName()` and injectable for a test) and refuses with
  `mode: "foreign"` when it is not. Without that check it would read Discord's own
  updater configuration, compare Discord's version against our feed and could quit
  Discord to run an installer for it;
* a run with **nothing to replace** says so and does not check: `mode: "elsewhere"`
  covers Linux without the `APPIMAGE` variable (a `deb` or a `tar.gz` install) and
  the portable Windows exe. The reason travels as `state.note` and is shown in the
  settings page's update row, beside the mode;
* in a packed build the feed comes from the build (`app-update.yml`, written from
  `build.publish`), so a shipped client updates itself; only
  `HYPERCORD_UPDATE_FEED` overrides it at runtime;
* a build with **no feed at all** logs one line and stays quiet instead of failing
  in a loop;
* an update is found and downloaded in the background and **installs on quit** -
  no dialog, no toast, no "restart to update" prompt, and no forced restart;
* one check ~30 s after launch, then every 6 hours (0 disables it), with
  `checkNow()`/`installNow()` available for a menu action.

The feed is this repository's own GitHub releases: `build.publish` uses the
`github` provider (owner `9ssault`, repo `hypercord`), so `electron-builder`
writes that feed into `app-update.yml` at build time and `electron-updater`
reads the release list directly. Attach `latest.yml` / `latest-mac.yml` /
`latest-linux.yml` to the release with the artifacts and a published release *is*
the update. (A `generic` feed URL used to be configured here; it pointed at
`updates.hypercord.app`, which resolves nowhere, which is why an installed client
could never update itself. Keep any replacement URL one that answers.) Set the
feed one of two ways:

1. `build.publish` in `package.json` (used by `electron-builder` to write the
   feed files at build time) - this is what a shipped build uses, or
2. `HYPERCORD_UPDATE_FEED=https://…` at runtime, which wins.

The channel file is named per platform, and on Linux **per architecture**:
`latest.yml` on Windows (one file for both architectures), `latest-mac.yml` on
macOS, and `latest-linux.yml` on x64 against `latest-linux-arm64.yml` on arm64.
Those names are not a convention of ours: `getChannelFilePrefix()` in
`electron-updater` asks for exactly them and `getArchPrefixForUpdateFile()` in
`app-builder-lib` writes them, and within a channel file the updater prefers the
artifact whose name matches `process.arch`. A release that built only x64 for Linux
therefore left every arm64 AppImage install asking for a file that was not there,
and silently never updating - which is why the release workflow now builds
`--linux --x64 --arm64` and uploads `dist/latest*.yml` rather than three fixed
names. `scripts/check-feed.mjs` is the other half of that guarantee: the publish
job reads every `latest*.yml` it is about to attach and **fails the release** when
one names an artifact that is not attached, so a feed pointing at nothing is a red
run instead of a client that never updates.

Note the platform caveat, which is a shape rather than a bug: the Windows `nsis`
installer and the Linux `AppImage` self-update from the feed; a macOS build only
once it is signed, because Gatekeeper refuses an unsigned replacement; and a `deb`,
a `tar.gz` or the portable Windows exe never, because none of them is an installed
copy of ours that an update could replace. `src/updater.js` is covered by
`npm run test:updater`, which stubs `app.isPackaged` and drives every path -
including the dev run, the two refusals above, a feed that cannot be reached, and
proving that a downloaded update says nothing to the user.

`npm run test:feed-live` is the half that suite cannot see, because it is not logic:
it starts the **packed build** with `HYPERCORD_UPDATE_FEED` pointed at a local feed
offering a version the build does not have, waits for the client's own update state
to report the download, and then ends the client before it can install. It is the
check that found the real bug - electron-updater reads the feed's *config* file
whatever feed it was given, so a build that shipped none (a `--dir` pack) saw
`update available`, then failed the download with `ENOENT ... app-update.yml`, which
reads exactly like a broken feed. It runs on every desktop runner in the release
workflow, after the installers, because the failure it covers only exists in an
artifact. A run with nothing to drive (no packed build, or no channel file for this
platform) prints `SKIPPED` and exits 0 instead of passing silently, and on Linux
without `APPIMAGE` the packed build has no updater at all - electron-updater's own
design - so what is asserted there is that it refuses, names the reason, and never
asks the feed for anything.

## Running the patched client, per platform

The same command on all three - there is no platform-specific way to do this:

```bash
npm start -- --attach
```

`src/patcher.js` finds an install, renames `app.asar` to `hypercord.app.asar`
(never rewriting it, so unpatch is byte-exact) and writes a `resources/app` entry
point that requires `src/loader.cjs`. What differs is only where the install is
found and how it is started:

| Platform | Where the install is found | How it is started |
| --- | --- | --- |
| **Windows** | `%LOCALAPPDATA%\Discord{,PTB,Canary}\app-<v>\resources`, the newest version first | that install's own `Discord.exe`, detached |
| **macOS** | `/Applications` and `~/Applications`, `Discord{ PTB, Canary}.app`; the version comes out of `Contents/Info.plist` | `open -a <the bundle>` - the bundle path, never the name, so the copy that opens is the copy that was patched |
| **Linux** | `$XDG_CONFIG_HOME` (or `~/.config`)/`discord{,ptb,canary}`/`app-<v>/resources`, the package roots (`/usr/share/discord`, `/opt/Discord`, `/usr/lib/discord`, `/usr/lib64/discord`), and Flatpak deployments under `/var/lib/flatpak/app` and `~/.local/share/flatpak/app` | the binary inside the install - `app-<v>/Discord`, or `Discord` beside `resources` for a package-managed one; a Flatpak deployment through `flatpak run <app-id>` |

On every platform: PTB and Canary are found as well, stable is preferred over them,
the newest version wins inside a channel, a `resources/app` that is not ours is
refused rather than touched, an install whose original was moved aside but has no
entry point is repaired, and with no Discord installed the Electron window *is* the
client. `--attach` only decides whether a real install is patched; the fallback
window needs no flag.

All three branches are covered by `tests/patcher/index.mjs`, which discovers each
layout from injected paths and then runs the whole round trip on it - inspect, patch,
what the manifest recorded, and unpatch restoring the directory exactly. What that
does and does not prove is spelled out under "Compatibility review" below.

### Linux: where the OS sandbox stays off

An AppImage that shows a healthy main process, one `Network service crashed or
was terminated` line, and then every page failing `ERR_FAILED` is not a broken
build - it is Chromium's OS-level sandbox dying at birth. The AppImage's setuid
helper cannot work on the FUSE mount, and the kernels users run refuse the
unprivileged-user-namespace fallback (Ubuntu 24.04's AppArmor
`kernel.apparmor_restrict_unprivileged_userns`, Debian's
`kernel.unprivileged_userns_clone=0`, most containers), so the network service,
the GPU process and the renderers never start while the main process carries on
as if nothing happened.

The shell therefore launches with `--no-sandbox` where the sandbox cannot work
anyway: as root, with `ELECTRON_DISABLE_SANDBOX=1`, and inside an AppImage
(`src/linux-sandbox.js` decides, `src/main.js` applies it before anything can
spawn a helper, and the reason is logged). That switch disables only the
OS-level sandbox - the window is still built with `sandbox: true`, so the
preload isolation stands. A plain Linux install (deb, tarball, dev checkout)
keeps the sandbox; `HYPERCORD_SANDBOX=0` keeps it everywhere, for whoever wants
to prove their kernel can do it. Covered by `tests/linux-sandbox/index.mjs`.

When `--no-sandbox` does *not* help, the sandbox was never the cause: the dead
giveaway is `Terminating current process after 15 seconds with no connection`
(the network-service child started fine and the browser never finished its
control-channel handshake) or a `SIGBUS` for the app in `coredumpctl`. On one
machine that exact pair traced to the FUSE mount the AppImage runs from, not to
the payload - the file's `sha256sum` matched the release digest exactly and the
extracted payload (`--appimage-extract`, then `squashfs-root/AppRun`) ran fine.
The workarounds in that order: `APPIMAGE_EXTRACT_AND_RUN=1` with the same file,
or the `deb`/`tar.gz` from the same release, which never touch FUSE.

## Building each target

```bash
npm run vendor        # merge + rebrand + write plugins/manifest.json
npm run dist -- --win --x64
npm run dist -- --linux --x64
npm run dist -- --mac --arm64      # needs macOS to sign/notarise
npm run dist -- --win --linux --x64 # one run, several targets
```

After a build, check the artifact rather than the source - a stale `dist/` looks
exactly like a working client until somebody opens it:

```bash
npm run pack                 # dist/win-unpacked (or the platform equivalent)
npm run check:packaged       # starts the built exe and reads its page
npm run check:packaged -- --fresh   # same, on a throwaway profile, so Discord
                                    # shows its login form
```

`scripts/check-packaged.mjs` starts the executable, attaches to its renderer over
the DevTools protocol, and asserts what the build actually injected: the token option
beside the login fields, Hypercord's entries inside Discord's settings, its pages
mounted with one page showing and no overlay of ours left in the page, and the
passkey policy. It starts the executable detached and ends it by **process group** on
Linux and macOS (`taskkill /T /F` on Windows), because Electron's renderer and GPU
children are processes of their own: ended by pid alone they survived the check and
held the throwaway profile, which the removal retry only papered over. It removes
that profile afterwards.

If a real Discord is installed, `npm start -- --attach` patches it and starts the
real client instead of this window (see [src/patcher.js](src/patcher.js)); the
Electron window is then the fallback. Nothing starts at boot and nothing stays
resident: closing the window ends Hypercord.Cross-building macOS artifacts requires macOS (or an Apple-signed CI runner); Windows and Linux artifacts can both be produced from either. The packaging config trims what ships: `asar`, maximum compression, `en-US` only, no source maps, no TypeScript sources.

## Compatibility review

Where the code is platform-specific and where it is not, read from the source.
**This checkout is Windows and nothing in this section was executed** - every claim
below is from reading the files named, and the places that cannot be verified here
say so.

**One platform branch, in one file.** `src/main.js` contains no `process.platform`
test at all; its only OS-specific call is `app.getPath("userData")`. Every
install discovery lives in `src/patcher.js` (`listInstalls`, line ~140): `win32`
over `%LOCALAPPDATA%`, `darwin` over `/Applications` and `~/Applications` with the
version read out of `Info.plist` and a bundle started with `open -a`, and everything
else as Linux - `$XDG_CONFIG_HOME` or `~/.config`, the installed package roots, and
Flatpak deployments under `/var/lib/flatpak/app` and `~/.local/share/flatpak/app`.
Because `platform`, `env`, `home`, `exists`, `readdir` and `readFile` are all
options, `tests/patcher/index.mjs` drives all three branches from any host.

**Neutral by construction, and worth keeping that way:**

* `src/updater.js` has **one** platform branch, and it names only what cannot be
  updated rather than how to: `mode: "elsewhere"` on Linux without the `APPIMAGE`
  variable and for the portable Windows exe (`platform` and `env` are options, so a
  test drives any of them from any host). Everything else is still decided by
  `app.getName()`, `app.isPackaged` and by whether `electron-builder` wrote
  `app-update.yml`, and nothing in the module knows where an installer keeps its
  files.
* `src/passkeys.cjs` is one injected policy with no OS test. It exists because of a
  Windows-specific dialog (Chromium raises the system passkey chooser for a
  conditional WebAuthn request), and because it refuses only uninvited requests it
  is harmless - and equally useful - on Linux and macOS, where the same
  conditional-mediation request is made.
* `scripts/measure.mjs` resolves the Electron binary per platform (`electron.exe`,
  `Electron.app/Contents/MacOS/Electron`, `electron`); `scripts/check-packaged.mjs`
  looks for the packed executable under `win-unpacked`, `mac`, `mac-arm64` and
  `linux-unpacked`; `scripts/release.mjs` knows the same four `app.asar` locations
  and special-cases only `npm.cmd` on Windows; `artifactsIn` matches
  `exe|appimage|deb|dmg|pkg|zip|tar.gz`, so a Linux or macOS run is recognised.
* `scripts/make-icons.mjs` writes `icon.png`, `icon.ico` and `icon.icns` from one
  procedural drawing with no image library and no network, so the Windows and macOS
  icons can be generated on a Linux host.

**Fixed since this list was first written** - kept with the reading it came from,
because the reading is what makes the fix checkable:

1. `scripts/check-packaged.mjs` started the built app with `detached: false` and
   ended it with `process.kill(child.pid, "SIGTERM")` on POSIX (Windows already got
   `taskkill /T`, which takes the whole tree). Electron's renderer and GPU children
   are separate processes, so a Linux or macOS check could leave them behind and hold
   the throwaway profile - the 10-second retry loop only hid it. It now spawns
   detached and ends the **process group** on Linux and macOS, keeping `taskkill /T /F`
   for win32. The fix is read, not run here: no Linux or macOS host was involved.

**Concrete gaps, with the fix, for whoever owns the file:**

1. `package.json` has no macOS signing configuration at all: on a macOS runner
   `npm run dist -- --mac` yields an unsigned, un-notarisable `dmg`, and on this host
   it fails partway through because `hdiutil` is not there. Setting
   `build.mac.identity: null` would make a local mac build fail immediately and
   plainly instead of at packaging time; a real release needs a developer identity,
   `CSC_*` or notarisation credentials, none of which are in this tree. What that
   costs is now said where it bites: the release job prints `signing: UNSIGNED` and
   `notarisation: none` when those secrets are absent, and the client reports the
   refusal in its update state - an update that Gatekeeper will not install is the
   one path this tree cannot make work without credentials.
2. No run against a real macOS or Linux Discord install is recorded anywhere in this
   repository. What *is* covered: `tests/patcher/index.mjs` discovers every layout from
   injected paths - Windows `%LOCALAPPDATA%`, a macOS bundle with its `Info.plist`, the
   Linux config directory, a package root and a Flatpak deployment - and then runs the
   whole round trip on each of them: `inspect` clean, `patch`, the manifest recording
   the loader, the channel and the version, the entry point requiring that loader and
   handing off to the real client, the client's own archive byte-identical, and
   `unpatch` putting the directory back exactly as it was. What no test can prove from
   this host is that a given distro's Discord tree looks like the one discovery
   expects: Flatpak deployments vary between distros (the code tries a documented inner
   name and then whatever is actually in the directory), and the macOS bundle is only
   checked against the layout this repository knows. Verified in the layout, not on the
   machine - the distinction is the point.
3. What self-updates is narrower than what is built, and that is
   `electron-builder`'s shape, not a bug: **true** for the Windows `nsis` installer,
   for the Linux `AppImage` on x64 and arm64 (each with its own channel file, see
   *Auto-update* above) and for a macOS build once it is signed; **false** for `deb`,
   `tar.gz` and the Windows portable exe, none of which is an installed copy of ours
   that an update could replace. Those runs now report that in their update state
   (`mode: "elsewhere"`) instead of checking a feed they could never install from.
