# Hypercord for Android

> **Branding note (desktop merge).** User-visible names are Hypercord: the app
> label, the loader's control button and messages, the log tags, this document and
> the exported backup default (`Hypercord-addons.json`). Identifiers that are
> shared with code or with data already on a device are deliberately **not**
> renamed here, because a half-renamed scheme, package or path breaks the client:
> the package ids `app.assault.manager` / `app.assault.loader` (and the XML package
> directories they must match), the `assault` / `assault-addon` / `assault-addons` /
> `assault-scripts` URI schemes, the `content://app.assault.manager.scripts`
> authority, the `assault` shared-preferences file, the asset names
> `assault-runtime.js` / `assault.js`, the `/assault` slash command, the
> `assault-runner` directory and the `assault-scripts-*.json` journals on a device,
> and the `ASSAULT_*` CI/signing variables. Those need one coordinated change
> across `core/`, `scripts/patch_runtime.py`, the Android sources and the on-device
> data migration.

## 2.12.0 isolated addon candidate

Plugins and Themes now use a bounded JavaScript interpreter, React Native manager/settings screens, local `.js`/`.txt` imports, checksum-verified HTTPS installation, private persistent state, and complete backups with optional cloud upload/restore. Legacy arbitrary plugins must be ported to the new API. See [the addon contract and validation limits](docs/addon-framework.md). Production device acceptance remains required.

## Addon sources the built-in browser can reach

The manager's addon pages can list and open the plugin and theme catalogues published by the other Discord client projects. The source of truth is [`addon-sources.json`](../addon-sources.json) - 21 entries, each recording what its URL actually returns, because each was fetched - and `docs/addon-sources.md` is the same list in prose. The copy the device reads is `core/sources.js`, reachable at runtime as `globalThis.__ASSAULT_ADDONS__.sources` with `all`, `byId`, `forKind`, `byPlatform`, `fetchPlan` and `unfetchableReason`. Nothing is fetched on a timer: a catalogue is read when a person asks for it.

**Android and mobile ecosystems**

- **Aliucord** - the plugin manifest at `https://plugins.aliucord.com/manifest.json` (JSON a program can read): name, version, metadata and the ZIP artifact URL for every published plugin, which makes it the best single Android source. The official monorepo, sources under `plugins/<plugin>/`, is listed at `https://api.github.com/repos/Aliucord/plugins/contents` (a GitHub listing, unauthenticated and rate-limited).
- **Aliucord themes** - there is no official theme index; that page is view-only. The closest thing is a directory listing of one community repository, `https://api.github.com/repos/catppuccin/aliucord/git/trees/main?recursive=1`, whose files are individual JSON themes.
- **Revenge** - the maintained mobile catalogue at `https://revenge-mod.github.io/revenge-community-plugins/index.json` (JSON): plugin id, version, channel, artifact URL and SHA-256 digest per entry. Themes are plugins in this ecosystem, so one list covers both kinds. The repository behind it, `https://github.com/revenge-mod/revenge-community-plugins`, is worth browsing but should not be walked by a program. `https://plugins-list.pages.dev/` is a community status site that is **not** affiliated with Revenge, and the author-maintained list at `https://revenge.nexpid.xyz/` (sources: `https://github.com/nexpid/RevengePlugins`) is a page whose apparent `index.json` returns 404 - both are for a person, not a parser.
- **Vendetta** - **discontinued in 2024**, so treat this as a legacy snapshot rather than a feed: the proxy still answers with an array of plugin URL strings at `https://raw.githubusercontent.com/vd-plugins/proxy/trunk/plugins.json`, the same list with metadata objects at `.../plugins-full.json`, and `https://vd-plugins.github.io/web/` is a rendered browser over them.
- **Bunny** - **archived**: `https://raw.githubusercontent.com/bn-plugins/vd-proxy/trunk/plugins.json` and `.../plugins-full.json`, the same shape with some Bunny-patched entries. One author's per-plugin publishing looks like `https://rico040.github.io/bunny-plugins/hideappbutton/manifest.json`, which is also the shape of a hand-added source URL.

**Desktop ecosystems**

- **Vencord** - plugin sources rather than artifacts: a directory listing at `https://api.github.com/repos/Vendicated/Vencord/contents/src/plugins?ref=main`, and plugin name to README text at `https://raw.githubusercontent.com/Vencord/builds/main/plugin-readmes.json` (descriptions only, no download URLs). `https://vencord.dev/plugins` is a rendered page, not an index.
- **Equicord** - generated metadata for its combined catalogue at `https://raw.githubusercontent.com/Equicord/Equibuilds/main/plugins.json`, with its own half at `.../equicordplugins.json` and the Vencord half at `.../vencordplugins.json`. Metadata and source paths only: there are no plugin ZIPs, and `themes.equicord.org` publishes no verified raw theme index.
- **BetterDiscord** - `https://betterdiscord.app/plugins` and `https://betterdiscord.app/themes` are rendered listings. Its addons are single files hosted by their authors, there is no shared repository and no verified raw catalogue endpoint, so open them in the browser.
- **Replugged** - `https://replugged.dev/store/plugins` is a store UI over per-addon manifests with no verified raw index, and themes here are arbitrary CSS URLs with no central catalogue anywhere.

**What the browser can and cannot do with them.** Fetchable is not installable. This client runs one documented addon dialect - the data-only `.txt`/`.js` addons in [addon-framework.md](addon-framework.md), with working examples at `plugins/examples/welcome.txt` and `themes/examples/midnight.txt` - and refuses general JavaScript by design. So a plugin from any project above, and a theme in another client's format, **cannot be installed here** however readable its catalogue is; the list is a map for finding, reading about and opening a project. Where a source has no machine-readable index, the pages must say so rather than show an empty list that looks broken.

Hypercord Manager is a **native Android app** that downloads Discord's Android APK splits, verifies their signer and version, embeds the Hypercord loader with LSPatch, and invokes Android's package installer. The installed client runs **Discord's own React Native interface**. There is no WebView client or simulated APK generator.

## 2.11.1 in-app expansion

- **Rich presence builder** in Manager and AS controls: text, application ID, activity type, images, links, two buttons, timestamps, party size and preview. Remote rendering depends on the installed client and Discord support.
- **More local commands** for search, capture, exports, privacy, reactions and presence. A searchable native command guide is available in both apps.
- **JSON saving**, independent privacy filters, outgoing text token guard and bounded ghost-ping retention.

See the [complete in-app guide](docs/in-app-controls.md) and [publish-your-own-release guide](docs/publish-your-release.md).

## Integrated release

Install Manager once: its matching loader is embedded and verified before merging into the client. The Manager shows the prepared client and loader status and verifies prepared file checksums before installation. Older prepared sets must be prepared again to create integrity metadata.

The web portal displays only actual release artifacts, with a local APK checksum checker. It does not connect to a phone or simulate successful installation.

After building, create the distributable ZIP (APKs, buildable source, licenses, checksums and installation instructions) - the step below stops at the gap described under [Build](#build):

```bash
npm run release:zip
```

The archive appears under `release/`. No Discord APK or private signing key is included.

## Install

1. Build/download `Hypercord-Manager.apk` and install it on Android. (The build currently writes `Assault-Manager.apk`; the artifact name is one of the identifiers listed in the branding note above.)
2. Tap **Download & prepare client**. Manager fetches the stable base, device ABI, English and density splits automatically.
3. Tap **Install prepared update**, grant permission to install apps from Manager, and confirm Android's prompt.
4. Open Hypercord and sign in using Discord's native login.

Manager uses `app.assault.manager` (kept: the package id, see the branding note). The patched client retains `com.discord` for native component compatibility. The initial patched install cannot update an official Discord installation signed by Discord: Android will report a signing conflict. Remove official Discord manually only after the patched client is ready; doing so clears its local data. Later Assault updates use the same private key and can preserve data. Keep Manager installed and its data intact: clearing it loses that local signing key. There is no key recovery: future updates then require reinstalling the patched client, which clears its local app data.

## Native features

- Discord supplies its native servers, channels, DMs, authentication, voice, media and attachment interface.
- The bundled runtime supplies its existing plugin and theme UI under Discord Settings → Hypercord. Third-party plugins may depend on a particular Discord version.
- Tap **AS** in the client for Hypercord controls (the button itself is the loader's control button; its label is Hypercord, its glyph is still the `ic_assault_foreground` asset): session message retention, edit capture, analytics-request blocking and safe mode. Restart Discord after changing a control.
- `/assault` → **export** prepares an HTML transcript for the current channel, including captured edit history and deletion markers. Tap **AS → Save latest HTML transcript** to save it through Android’s document picker. Capture is session-only, defaults to 500 messages / 20 edits and a 4 MiB retained-content budget, and clears on logout or account switch. Native controls offer smaller/larger limits, optional expiry, attachment capture and author-redacted exports. It cannot recover unseen messages or older deleted content.
- **Updates** in client controls opens the separate Manager. Manager checks on launch. Its scheduled job prepares newer client or loader builds; choose 6/24/72-hour checks, unmetered networking and charging requirements. Defaults are daily, unmetered and charging; installation always uses Android confirmation. Android can defer scheduled work.
- Automatic checks and **Check client & manager updates** also read this repository's latest GitHub release. A manager update must be named `Assault-Manager.apk`, have a newer version code, and be signed by the currently installed manager's certificate. New Manager releases are prepared automatically and get their own install button. A published release is required for this path.

The previous React demo's fake Nitro billing, synthetic accounts, fake encryption claims, pretend Smali pipeline and empty 4 KB APKs are no longer the application entry point. Their unreachable source and unused dependencies have been removed. They are **not implemented native functionality**. This build does not claim that every old prototype toggle has been ported.

## Account controls and HTML export (2.8.0)

- One `/assault` command offers **export**, **export-deleted**, **clear**, **clear-all**, **status** and **help**. The former separate command aliases are removed. HTML exports escape message text and attachment names, contain no scripts or remote images, and allow only HTTPS attachment links. Capture errors allow Discord dispatch to continue; counts and stored content are bounded. The budget estimates retained content, not the entire JavaScript heap or temporary export allocations.
- Native controls include hook/theme diagnostics, safe mode, independent native theme colors, left/right control button placement, crash-report filtering and a native-only mode. Turning off the Hypercord runtime also turns off all JavaScript features; defaults retain plugins, themes and capture.
- Manager adds preparation cancellation, bounded download retries, storage checks, cleanup that keeps the prepared client and signing identity, event-driven status, and loader-aware updates. Automatic launch checks are cached for six hours; manual checks bypass the cache. Android controls scheduling and confirms installs.
- Black/red vector AS icons cover Manager, the loader and the patched client's default launcher icon, with adaptive and monochrome layers. Discord's optional alternate launcher icons remain selectable. Unsupported native ZIP alignment or default icon layouts fail preparation while preserving the existing prepared client.
- Release R8 optimization and resource shrinking apply to both Android modules. No new runtime dependency was added. The pinned patcher JAR is separated into Java code and opaque injection assets; the single patched `ApkPatcher` source replaces its dependency counterpart. Plugins/themes load only when enabled; native controls are built on demand. Idle UI polling and capture cleanup timers are absent.

Historical 2.7.0 measurement — Manager: **6,200,704 bytes (5.91 MiB)**, down **47.3%** from 11,771,650 bytes. Loader: **144,614 bytes**, up 6,556 bytes for controls, bounded capture and vector resources. Manager savings include removing unused patcher classes; the patcher's heavy build-time code is never injected into Discord. Discord's original libraries and behavior are preserved. See [expansion details](docs/expansion-2.7.md).

### Selecting an account profile

In Manager, open **Account controls → Configure profile**, choose **Local controls** or **Controls + custom presence**, then tap **Apply profile to client**. Confirm inside the client and restart it. You can also edit the same settings directly through **AS → Account controls**. Profiles start **off** and use the existing signed-in client; no account token or extra login is needed.

The supplied scripts' supported controls are adapted into built-in profiles:

- A configurable local prefix (default `$`) handles `help`, `status`, `stop`, `start`, `prefix <value>` and `react on|off` before messages are sent. Unknown commands and ordinary text continue through Discord normally. Prefix changes made by command last for the session; native settings hold the defaults.
- Optional reactions to **your own new messages**, deduplicated and limited to one per ten seconds. Server retry delays are respected; there are no retry loops. Availability is shown by the status command.
- The presence profile can set a Playing activity and online/idle/DND/invisible status on Discord's next existing gateway presence update. It does not open another connection, alter identify credentials, spoof Spotify/console sessions or change notification settings. Some client versions may not expose this hook; verify the status from another device.
- Logout or account switch pauses controls. `$start` resumes them explicitly. Capture still clears on logout/account switch.

These profiles are **not an arbitrary Node-script runner**. Node filesystem/HTTP servers, token fleets, multi-account voice joining, targeted spam, group renaming/deletion and fabricated quest progress/reward claims are not included. Discord's ordinary voice UI and the existing plugin/theme system remain available. Original runtime APIs, module identifiers, update URLs and license notices are preserved; only selected display labels use Assault branding.

HTML is prepared in the client's private cache. **Save latest HTML transcript** snapshots that file before opening the document picker. Canceling leaves the latest cached transcript available for retry. Clear-all/logout removes the latest cached export; files you have already saved are yours to manage. HTML displays deletion markers, edit history and optional captured attachments, and respects author-redaction settings.

## Build

Requirements for the Java half: Java 21, Android SDK platform 36 and build-tools 36.0.0, with Python 3.9+ for the helper scripts. The release workflow under `.github/workflows/android-release.yml` pins **JDK 17** and Node 20, so the two disagree about the JDK today.

**Known gap: as it stands this tree cannot build the APK.** What is here is source - the `android/manager/` and `android/loader/` Java sources and resources, the JavaScript half in `core/`, `utils/`, `plugins/` and `themes/`, the `node --test tests/*.test.mjs` suites, and the desktop client's own `package.json` and lockfile. What is **not** here: a Gradle wrapper or any `*.gradle` / `settings.gradle`, an Android `package.json`, `scripts/build_android.py`, `scripts/candidate_artifacts.py`, `scripts/pack_release_artifacts.py`, `scripts/android-dependencies.json`, `android/licenses/` and `android/LICENSE`. The commands below are therefore not supported by anything in this repository, the download portal and `public/releases/` are not part of it either, and `docs/android-build-release.md`, `docs/in-app-controls.md`, `docs/publish-your-release.md`, `docs/android-validation.md`, `docs/expansion-2.7.md` and `docs/release-notes.md` do not exist. Restoring the build means bringing the wrapper, the dependency pins and the packaging scripts back together; the signing identity is the one part that cannot be recreated.

```bash
# The intended sequence, not a script this tree currently ships.
export ANDROID_HOME=/path/to/android-sdk
npm ci
npm run build:android
npm test
npm run build
npm run dev
```

`build:android` was meant to verify pinned dependency SHA-256 values, builds Manager and its embedded loader, runs Android lint and verifies the APK signature. It writes `public/releases/Assault-Manager.apk`, an immutable content-hash APK for portal downloads, and an atomically switched manifest. Retain the immutable APKs while old download links are in use. These outputs are ignored by Git. No Discord APK is redistributed by this repository; Manager fetches and verifies it on-device. Release builds are meant to use a persistent private key at `$HOME/.local/share/assault/signing/manager.p12` with a protected password file beside it. Back up this directory securely before moving build environments. The release workflow decodes the `KEYSTORE_BASE64` secret into `HYPERCORD_KEYSTORE_PATH` and expects `HYPERCORD_SIGNING_PASSWORD` to reuse the same identity. Never commit or distribute signing material. A different signing key cannot update an existing Manager installation.

The web app at port 3000 (not in this tree) is a **download portal**. It serves actual generated artifacts and reports an unavailable build until Android compilation succeeds. It does not proxy Discord credentials or pretend to run Discord in an iframe.

The [Android build, install and release instructions](docs/android-build-release.md) that described all four APK variants, reinstall commands and device checks are not in the tree. What does remain is the tag-triggered workflow at `.github/workflows/android-release.yml`: it prepares `Hypercord-Manager.apk` and `Hypercord-Loader.apk`, expects `KEYSTORE_BASE64` and `HYPERCORD_SIGNING_PASSWORD` as repository Actions secrets, requires an HTTPS acceptance record before publishing, and calls the three `scripts/*.py` helpers named above as missing.

## Where the code comes from

Nothing here is Discord's code, and none of it is copied from another client:

- **Discord supplies the client.** Manager downloads Discord's own APK splits, verifies their signer, package and version, and merges the loader in. No Discord APK is redistributed by this repository, and the patched client keeps `com.discord` for native component compatibility.
- **LSPatch v1.2** ([github.com/JingMatrix/LSPatch](https://github.com/JingMatrix/LSPatch/tree/v1.2), GPL-3.0): the APK patcher and the embedded runtime. The pinned patcher JAR is separated into Java code and opaque injection assets, and `android/manager/src/main/java/org/lsposed/patch/ApkPatcher.java` is the single patched source that replaces its dependency counterpart.
- **Revenge v1.11.6** ([github.com/revenge-mod/revenge-bundle](https://github.com/revenge-mod/revenge-bundle/tree/v1.11.6), BSD-3-Clause): the native React Native plugin and theme runtime the loader injects, which is why the plugin and theme UI lives under Discord's own Settings.
- **Xposed API 82** (Apache-2.0): the compile-only hook API the loader is built against.
- **Acorn** (MIT): the licence text the loader packages as `licenses/Acorn-MIT.txt`; `tests/loader-assets.test.mjs` is the suite that names it.
- **Ours.** The addon interpreter and its manager screens (`plugins/index.js`, `plugins/sandbox.js`, `themes/index.js`, `core/`, `utils/`), the loader's capture and control code, `scripts/patch_runtime.py`, and everything written in this document. The dialect those addons are written in is specified in [addon-framework.md](addon-framework.md), with working examples at `plugins/examples/welcome.txt` and `themes/examples/midnight.txt`.
- **Kept identifiers are not provenance.** The `assault` / `assault-addon` / `assault-addons` / `assault-scripts` schemes, the `app.assault.*` package ids and the on-device `assault-*` journals stay as they are because code in both halves and data already on a device use them; only display text is branded Hypercord. The note at the top of this file lists them.
- **Other clients' catalogues are not vendored either.** The addon sources listed above are third-party catalogues the browser can find and open; nothing from them is copied into the client, and only this client's own addon dialect installs.

## Source and trust

- [LSPatch v1.2](https://github.com/JingMatrix/LSPatch/tree/v1.2): native APK patcher and embedded runtime, GPL-3.0.
- [Revenge v1.11.6](https://github.com/revenge-mod/revenge-bundle/tree/v1.11.6): native React Native plugin/theme runtime, BSD-3-Clause.
- Xposed API 82: compile-only API, Apache-2.0.
- Exact dependencies and checksums: `scripts/android-dependencies.json`. License texts: `android/licenses/`. **Neither is in this tree as it stands**, and `android/LICENSE` is not either: the notices above record what the bundled sources are licensed under, not copies of their licences.

The new Android implementation is provided under GPL-3.0; see `android/LICENSE`. Revenge and Xposed retain their own notices. The code does not imply endorsement by these projects.

Base downloads currently use `tracker.vendetta.rocks`, the mirror used by the upstream manager. Every APK must verify cryptographically, match package `com.discord` and the requested version, and match the pinned baseline signer `3c39d23cf9367849a5c699395647fe0e5bfea5a1f1f40d8c717ddc70f8bfa113`. The pin was obtained from the verified 347012 baseline APK. If Discord rotates its signing key, update the pin only after verifying the new identity. Network failures, incompatible versions and signature failures are shown as errors; no fabricated success is returned.

## Validation scope

Build, lint, signature verification, native patching and wrapper regression checks can run without a phone. Real login, voice, notifications, plugin compatibility and Android install confirmation require device validation. Targeting SDK 36 alone does not establish complete Android 16 compatibility. See `docs/android-validation.md` for the observed results and remaining checks.

The floating **AS** control can be dragged to a saved position. Tap it to open controls; **Reset AS button position** restores its default left/right placement.

AS settings use native grouped cards with system light/dark colors, scalable text and touch targets. The panel adapts to the current phone/tablet or multi-window area; the draggable button stays inside visible bounds, including the keyboard and display cutouts. Android 9 (API 28) remains the minimum. OEM skins, unusual fold/hinge layouts and every Android version cannot be certified from the available emulator.

### Android script runner

See [Code runner setup and behavior](docs/code-runner.md) for the Termux-backed JavaScript, Python and Shell tabs, per-project dependencies, persistence and process controls. Rebuild Manager and prepare the client again for the new bridge.
