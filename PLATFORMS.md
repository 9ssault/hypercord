# Platforms

Hypercord is an Electron app, and Electron is a desktop runtime. That decides
what each platform gets - stated plainly rather than promised:

| Platform | How it ships | Notes |
| --- | --- | --- |
| **Windows** | `nsis` installer + portable exe, x64 and arm64 | the primary target; `electron-updater` installs the next release on quit |
| **Linux** | `AppImage`, `deb`, `tar.gz`, x64 and arm64 | AppImage self-updates through the same feed; `deb` updates like any package |
| **macOS** | `dmg` + `zip`, x64 and arm64 (Apple Silicon) | the `zip` is what the updater consumes; signing/notarisation needs an Apple developer identity, so an unsigned build will warn on first open |
| **Android** | **not Electron, and not built.** Today: the client is served by the control server (`/discord`) and installed from the browser as a PWA, or wrapped as a TWA with `bubblewrap`/PWABuilder using `pwa/manifest.webmanifest`. The APK path (a manager that patches a Discord APK, the shape Revenge Manager and Aliucord Manager use) exists as **sources only**: `android/manager/` and `android/loader/` hold the Java, the manifest and the assets, but the tree has no Gradle wrapper, no `build.gradle`/`settings.gradle` and no `scripts/build_android.py`, so **no APK can be produced from this checkout** - the CI workflow that expects those scripts cannot run here either. Sources present is not the same as an artifact, and none is claimed | Electron cannot run on Android. `rea` is an analysis toolkit, not a patcher, and this machine has no APK, Android SDK or JDK 25, so no APK is claimed |
| **iOS** | same served client, added to the home screen as a web app | no Electron, no sideloading story worth claiming |

## Auto-update

`src/updater.js` uses Electron's own updater through `electron-updater`, and it is
**silent by design**:

* a **development run never updates itself** (`app.isPackaged` is false, so the
  updater says so and stops) - otherwise a working tree would be replaced under
  you;
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

Note the platform caveat: AppImage and Windows installs self-update from the
feed; a macOS build must be signed for the update to install, because Gatekeeper
refuses an unsigned replacement. `src/updater.js` is covered by
`npm run test:updater`, which stubs `app.isPackaged` and drives every path -
including proving that a downloaded update says nothing to the user.

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
the DevTools protocol, and asserts what the build actually injected: the rail and
its tabs, the token option beside the login fields, the manager sheet with its own
tabs, and the passkey policy. It kills the process tree it started and removes the
throwaway profile afterwards.

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
test at all; its only OS-specific call is `app.getPath("userData")`, and the rail
shortcut is `CommandOrControl+Shift+H`, which is the right key on all three. Every
install discovery lives in `src/patcher.js` (`listInstalls`, line ~140): `win32`
over `%LOCALAPPDATA%`, `darwin` over `/Applications` and `~/Applications` with the
version read out of `Info.plist` and a bundle started with `open -a`, and everything
else as Linux - `$XDG_CONFIG_HOME` or `~/.config`, the installed package roots, and
Flatpak deployments under `/var/lib/flatpak/app` and `~/.local/share/flatpak/app`.
Because `platform`, `env`, `home`, `exists`, `readdir` and `readFile` are all
options, `tests/patcher/index.mjs` drives all three branches from any host.

**Neutral by construction, and worth keeping that way:**

* `src/updater.js` has no platform branch: whether an update is possible is decided
  by `app.isPackaged` and by whether `electron-builder` wrote `app-update.yml`.
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

**Concrete gaps, with the fix, for whoever owns the file:**

1. `scripts/check-packaged.mjs:132` starts the built app with `detached: false` and
   line 257 kills it with `process.kill(child.pid, "SIGTERM")` on POSIX (Windows gets
   `taskkill /T`, which takes the whole tree). Electron's renderer and GPU children
   are separate processes, so on Linux and macOS the check can leave them behind and
   hold the throwaway profile - the 10-second retry loop only hides it. Fix: spawn
   with `detached: true` and kill the process group on POSIX, keeping `taskkill /T`
   for win32.
2. `package.json` has no macOS signing configuration at all: on a macOS runner
   `npm run dist -- --mac` yields an unsigned, un-notarisable `dmg`, and on this host
   it fails partway through because `hdiutil` is not there. Setting
   `build.mac.identity: null` would make a local mac build fail immediately and
   plainly instead of at packaging time; a real release needs a developer identity,
   `CSC_*` or notarisation credentials, none of which are in this tree.
3. The patched-Discord path is exercised on Windows only. The `darwin` and Linux
   branches of `listInstalls` run under the unit suite with injected paths, but no run
   against a real macOS or Linux Discord install is recorded anywhere in this
   repository, and Flatpak deployments vary between distros - the code already tries
   a documented inner name and then whatever is actually in the directory. Treated as
   unverified, not as working.
4. macOS AppImage-equivalents do not exist, and the `deb` does not self-update: that
   is `electron-builder`'s shape, not a bug, but it means "updates on all platforms" is
   true for `nsis`, `portable`, `AppImage` and a signed `zip`-based macOS build, and
   false for `deb` and `tar.gz`, which are updated by whoever installed them.
