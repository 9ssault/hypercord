# Platforms

Hypercord is an Electron app, and Electron is a desktop runtime. That decides
what each platform gets - stated plainly rather than promised:

| Platform | How it ships | Notes |
| --- | --- | --- |
| **Windows** | `nsis` installer + portable exe, x64 and arm64 | the primary target; `electron-updater` installs the next release on quit |
| **Linux** | `AppImage`, `deb`, `tar.gz`, x64 and arm64 | AppImage self-updates through the same feed; `deb` updates like any package |
| **macOS** | `dmg` + `zip`, x64 and arm64 (Apple Silicon) | the `zip` is what the updater consumes; signing/notarisation needs an Apple developer identity, so an unsigned build will warn on first open |
| **Android** | **not Electron, and not built.** Today: the client is served by the control server (`/discord`) and installed from the browser as a PWA, or wrapped as a TWA with `bubblewrap`/PWABuilder using `pwa/manifest.webmanifest`. The APK path (a manager that patches a Discord APK, the shape Revenge Manager and Aliucord Manager use) is planned in [android/README.md](android/README.md) and is explicitly **not** delivered or verified | Electron cannot run on Android. `rea` is an analysis toolkit, not a patcher, and this machine has no APK, Android SDK or JDK 25, so no APK is claimed |
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

The feed is a `generic` URL pointing at the release directory (GitHub Releases
assets work: point it at
`https://github.com/<owner>/hypercord/releases/latest/download` and publish
`latest.yml` / `latest-mac.yml` / `latest-linux.yml` with the artifacts). Set it
one of two ways:

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
resident: closing the window ends Hypercord.

Cross-building macOS artifacts requires macOS (or an Apple-signed CI runner);
Windows and Linux artifacts can both be produced from either. The packaging
config trims what ships: `asar`, maximum compression, `en-US` only, no source
maps, no TypeScript sources.
