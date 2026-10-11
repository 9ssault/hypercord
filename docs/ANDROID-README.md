# Assault for Android

## 2.12.0 isolated addon candidate

Plugins and Themes now use a bounded JavaScript interpreter, React Native manager/settings screens, local `.js`/`.txt` imports, checksum-verified HTTPS installation, private persistent state, and complete backups with optional cloud upload/restore. Legacy arbitrary plugins must be ported to the new API. See [the addon contract and validation limits](docs/addon-framework.md). Production device acceptance remains required.

Assault Manager is a **native Android app** that downloads Discord's Android APK splits, verifies their signer and version, embeds the Assault loader with LSPatch, and invokes Android's package installer. The installed client runs **Discord's own React Native interface**. There is no WebView client or simulated APK generator.

## 2.11.1 in-app expansion

- **Rich presence builder** in Manager and AS controls: text, application ID, activity type, images, links, two buttons, timestamps, party size and preview. Remote rendering depends on the installed client and Discord support.
- **More local commands** for search, capture, exports, privacy, reactions and presence. A searchable native command guide is available in both apps.
- **JSON saving**, independent privacy filters, outgoing text token guard and bounded ghost-ping retention.

See the [complete in-app guide](docs/in-app-controls.md) and [publish-your-own-release guide](docs/publish-your-release.md).

## Integrated release

Install Manager once: its matching loader is embedded and verified before merging into the client. The Manager shows the prepared client and loader status and verifies prepared file checksums before installation. Older prepared sets must be prepared again to create integrity metadata.

The web portal displays only actual release artifacts, with a local APK checksum checker. It does not connect to a phone or simulate successful installation.

After building, create the distributable ZIP (APKs, buildable source, licenses, checksums and installation instructions):

```bash
npm run release:zip
```

The archive appears under `release/`. No Discord APK or private signing key is included.

## Install

1. Build/download `Assault-Manager.apk` and install it on Android.
2. Tap **Download & prepare client**. Manager fetches the stable base, device ABI, English and density splits automatically.
3. Tap **Install prepared update**, grant permission to install apps from Manager, and confirm Android's prompt.
4. Open Assault and sign in using Discord's native login.

Manager uses `app.assault.manager`. The patched client retains `com.discord` for native component compatibility. The initial patched install cannot update an official Discord installation signed by Discord: Android will report a signing conflict. Remove official Discord manually only after the patched client is ready; doing so clears its local data. Later Assault updates use the same private key and can preserve data. Keep Manager installed and its data intact: clearing it loses that local signing key. There is no key recovery: future updates then require reinstalling the patched client, which clears its local app data.

## Native features

- Discord supplies its native servers, channels, DMs, authentication, voice, media and attachment interface.
- The bundled runtime supplies its existing plugin and theme UI under Discord Settings → Assault. Third-party plugins may depend on a particular Discord version.
- Tap **AS** in the client for Assault controls: session message retention, edit capture, analytics-request blocking and safe mode. Restart Discord after changing a control.
- `/assault` → **export** prepares an HTML transcript for the current channel, including captured edit history and deletion markers. Tap **AS → Save latest HTML transcript** to save it through Android’s document picker. Capture is session-only, defaults to 500 messages / 20 edits and a 4 MiB retained-content budget, and clears on logout or account switch. Native controls offer smaller/larger limits, optional expiry, attachment capture and author-redacted exports. It cannot recover unseen messages or older deleted content.
- **Updates** in client controls opens the separate Manager. Manager checks on launch. Its scheduled job prepares newer client or loader builds; choose 6/24/72-hour checks, unmetered networking and charging requirements. Defaults are daily, unmetered and charging; installation always uses Android confirmation. Android can defer scheduled work.
- Automatic checks and **Check client & manager updates** also read this repository's latest GitHub release. A manager update must be named `Assault-Manager.apk`, have a newer version code, and be signed by the currently installed manager's certificate. New Manager releases are prepared automatically and get their own install button. A published release is required for this path.

The previous React demo's fake Nitro billing, synthetic accounts, fake encryption claims, pretend Smali pipeline and empty 4 KB APKs are no longer the application entry point. Their unreachable source and unused dependencies have been removed. They are **not implemented native functionality**. This build does not claim that every old prototype toggle has been ported.

## Account controls and HTML export (2.8.0)

- One `/assault` command offers **export**, **export-deleted**, **clear**, **clear-all**, **status** and **help**. The former separate command aliases are removed. HTML exports escape message text and attachment names, contain no scripts or remote images, and allow only HTTPS attachment links. Capture errors allow Discord dispatch to continue; counts and stored content are bounded. The budget estimates retained content, not the entire JavaScript heap or temporary export allocations.
- Native controls include hook/theme diagnostics, safe mode, independent native theme colors, left/right AS button placement, crash-report filtering and a native-only mode. Turning off the Assault runtime also turns off all JavaScript features; defaults retain plugins, themes and capture.
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

Requirements: Java 21, Python 3.9+, Android SDK platform 36 and build-tools 36.0.0. The committed Gradle wrapper pins Gradle 8.13 and its checksum.

```bash
export ANDROID_HOME=/path/to/android-sdk
npm ci
npm run build:android
npm test
npm run build
npm run dev
```

`build:android` verifies pinned dependency SHA-256 values, builds Manager and its embedded loader, runs Android lint and verifies the APK signature. It writes `public/releases/Assault-Manager.apk`, an immutable content-hash APK for portal downloads, and an atomically switched manifest. Retain the immutable APKs while old download links are in use. These outputs are ignored by Git. No Discord APK is redistributed by this repository; Manager fetches and verifies it on-device. Release builds use a persistent private key at `$HOME/.local/share/assault/signing/manager.p12` with a protected password file beside it. Back up this directory securely before moving build environments. CI can supply `ASSAULT_KEYSTORE_PATH` and `ASSAULT_SIGNING_PASSWORD` (alias `assault`) to reuse the same identity. Never commit or distribute signing material. A different signing key cannot update an existing Manager installation.

The web app at port 3000 is a **download portal**. It serves actual generated artifacts and reports an unavailable build until Android compilation succeeds. It does not proxy Discord credentials or pretend to run Discord in an iframe.

See [Android build, install and release instructions](docs/android-build-release.md) for all four APK variants, reinstall commands, device checks, and the tag-triggered GitHub Releases workflow. Configure `ASSAULT_KEYSTORE_BASE64` and `ASSAULT_SIGNING_PASSWORD` as repository Actions secrets before pushing a version tag.

## Source and trust

- [LSPatch v1.2](https://github.com/JingMatrix/LSPatch/tree/v1.2): native APK patcher and embedded runtime, GPL-3.0.
- [Revenge v1.11.6](https://github.com/revenge-mod/revenge-bundle/tree/v1.11.6): native React Native plugin/theme runtime, BSD-3-Clause.
- Xposed API 82: compile-only API, Apache-2.0.
- Exact dependencies and checksums: `scripts/android-dependencies.json`. License texts: `android/licenses/`.

The new Android implementation is provided under GPL-3.0; see `android/LICENSE`. Revenge and Xposed retain their own notices. The code does not imply endorsement by these projects.

Base downloads currently use `tracker.vendetta.rocks`, the mirror used by the upstream manager. Every APK must verify cryptographically, match package `com.discord` and the requested version, and match the pinned baseline signer `3c39d23cf9367849a5c699395647fe0e5bfea5a1f1f40d8c717ddc70f8bfa113`. The pin was obtained from the verified 347012 baseline APK. If Discord rotates its signing key, update the pin only after verifying the new identity. Network failures, incompatible versions and signature failures are shown as errors; no fabricated success is returned.

## Validation scope

Build, lint, signature verification, native patching and wrapper regression checks can run without a phone. Real login, voice, notifications, plugin compatibility and Android install confirmation require device validation. Targeting SDK 36 alone does not establish complete Android 16 compatibility. See `docs/android-validation.md` for the observed results and remaining checks.

The floating **AS** control can be dragged to a saved position. Tap it to open controls; **Reset AS button position** restores its default left/right placement.

AS settings use native grouped cards with system light/dark colors, scalable text and touch targets. The panel adapts to the current phone/tablet or multi-window area; the draggable button stays inside visible bounds, including the keyboard and display cutouts. Android 9 (API 28) remains the minimum. OEM skins, unusual fold/hinge layouts and every Android version cannot be certified from the available emulator.

### Android script runner

See [Code runner setup and behavior](docs/code-runner.md) for the Termux-backed JavaScript, Python and Shell tabs, per-project dependencies, persistence and process controls. Rebuild Manager and prepare the client again for the new bridge.
