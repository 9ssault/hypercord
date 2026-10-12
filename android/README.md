# Android

This is a plan with the evidence attached, not a build. Read the last section
before believing anything else in this file.

## What REA is, and is not

`https://github.com/morluto/rea` ("Reverse Engineer Anything") is an
agent/MCP toolkit that *analyses* software - it drives headless JADX for Android
APKs and tooling for JavaScript and native binaries. It is configured in
`~/.agents/mcp.json` here as `npx -y rea-agents@3.0.0 mcp`, and it is useful for
exactly one step of this pipeline:

```bash
npx -y rea-agents@latest analyze-apk /absolute/path/to/discord.apk --json
```

It is **not** a Discord patcher, it does not know about Discord's structure, and it
does not produce a modified APK. Anything that claims otherwise is a different
tool with a similar name (Revenge, REAndroid/APKEditor).

## The real pipeline in 2026

Discord's Android mods are of two shapes, and they differ in the thing that
matters - who supplies the APK:

1. **A manager app that patches on-device (non-root).** The user installs the
   manager; the manager downloads a Discord version it supports, patches it, and
   installs the result as a separate app. This is what **Revenge Manager** does
   today (documented install flow; releases list v1.3.0, 2026-01-12), and it is
   also the shape of **rainManager**, **KettuManager** and **Aliucord Manager**
   (Aliucord is the legacy native-view client, not the React Native one).
2. **An Xposed/LSPosed module (root).** RevengeXposed loads the mod's Hermes
   bytecode bundle *inside* the official Discord process, so nothing is repacked
   and nothing is re-signed.

The projects publish **JavaScript bundles**, not APKs - `bun run build` /
`pnpm build` in Kettu, Bunny, Revenge and Rain produce a bundle that a loader
consumes. Vendetta is discontinued (2024-06-02), Bunny is archived, and Kettu
contributes through Codeberg with a GitHub mirror.

A hand-built repack, if we ever need one, is: merge splits
(`java -jar APKEditor.jar m -i split-apks -o discord-universal.apk`), patch,
`zipalign -p -f 4`, then `apksigner sign` with our own keystore and
`apksigner verify`. JDK 25 and Build Tools 36 are what the Revenge plugin
template asks for; they are not proven requirements of the manager itself.

## What Hypercord's Android build would be

The honest answer: **a manager, not a fork of Discord.** Hypercord's own code is
the plugin platform, the theme system and the rail - none of which is
Android-specific - so the Android deliverable is a manager that bundles a Discord
APK with our modifications, in the shape the projects above already use:

* the Hyper plugins would be generated from the same
  `plugins/hyper/` sources and the same `scripts/vendor.mjs` catalogue, so one
  plugin definition serves both platforms - the two app modules below exist, but no
  plugin source has been adapted for Android any more than the desktop ones were
  before `src/loader.cjs`;
* the manager is a small Android app (Kotlin) that fetches or accepts a Discord
  APK, verifies its version, injects the bundle,
* signs the result with a keystore the user controls, and installs it;
* direct Play distribution is not available for a modified client; expect
  sideloading, and expect Play Protect to warn.

## What is not done, and cannot be verified from here

- No APK is built, and none is claimed. There is now a Gradle build (see below),
  but it cannot produce one yet: the sources are incomplete and the toolchain is not
  on the machine that wrote the build. The exact missing pieces are listed in the
  next section, because "no APK" is not useful and "missing InstallReceiver.java,
  app.assault.shared, res/, four jars" is.
- `rea` is available as an MCP server and its analysis commands are the only part
  of this we can use today: given an APK, `analyze-apk` is how we would learn
  which Discord version and which bundle layout we are dealing with.
- The interface a mobile loader expects from a plugin (Hermes bytecode bundle vs
  plain JS module, and its registration API) is **not verified** here. Until an
  APK and a loader are in hand, our plugin sources must be assumed to need an
  adapter, exactly as the desktop ones needed `src/loader.cjs`.

## The build that now exists, and what it still needs

The Gradle build is authored and checked in: `settings.gradle`, `build.gradle` and
`gradle.properties` at the repository root, a module build for each app under
`android/manager/` and `android/loader/`, and ProGuard rules beside each of them.
It is pinned to Android Gradle Plugin 8.9.0 with Gradle 8.11.1, `compileSdk` and
`targetSdk` 36 (what the release workflow and this document ask for), `minSdk` 26
(`java.util.Base64` and the install-unknown-apps screen are API 26), Java 21, and a
release signing config that reads `HYPERCORD_KEYSTORE_PATH` /
`HYPERCORD_SIGNING_PASSWORD` - the same two variables `.github/workflows/android-release.yml`
exports - while still producing an unsigned release APK when they are absent, which is
the behaviour that workflow depends on.

There is no `gradle-wrapper.jar`: it is a binary nobody can write by hand, so
`./gradlew` reports a missing main class until somebody runs `gradle wrapper
--gradle-version 8.11.1` once on a machine with Gradle and commits the jar, the
scripts and the properties together.

**What the build still cannot do, and why - each item is a build failure, and the
message Gradle prints does not name the missing file:**

1. `app.assault.shared` - `AccountSettings`, `CommandGuide` and `RichPresence` are
   imported by `ManagerActivity` and by `AssaultLoader`, and no file in this
   repository defines the package. The module is deliberately *not* declared in
   `settings.gradle`, so the failure stays "package app.assault.shared does not
exist" instead of becoming an error about an empty project.
2. `ClientEngine`, `ReleaseSource` and `ManagerUpdater` - referenced throughout
   `ManagerActivity` and defined nowhere either. This is the app's own engine,
   release feed and updater; the APK cannot be assembled without them.
3. `InstallReceiver` and `UpdateJob` - declared in
   `android/manager/src/main/AndroidManifest.xml` and absent from the tree.
4. `res/` - there is no `src/main/res` at all, and the manifest asks for
   `@mipmap/ic_launcher` and `@xml/data_extraction_rules`. Nothing here draws from
   XML (every screen is built programmatically), so those two resources are all that
   must exist.
5. Four jars under `android/manager/libs/`: apkzlib (the `com.android.tools.build.apkzlib.*`
   signing and zip classes), ManifestEditor (`com.wind.meditor.*`), and LSPatch's own
   `share` and `patch` modules (`org.lsposed.lspatch.share.*`, `org.lsposed.patch.util.*`).
   Those class names are what `ApkPatcher` imports; the coordinates are not published
   under them, so the build declares file dependencies and leaves the four lines
   commented until the jars exist rather than guessing a version.
6. `android/loader/src/main/AndroidManifest.xml` - an application module without a
   manifest does not build, and the loader has none. It needs the package and the
   Xposed entry-point meta-data, nothing more.
7. `android/loader/src/main/assets/` - the ten files the release verification
   requires, generated by `scripts/build_android.py`: `xposed_init` (whose content is
   `app.assault.loader.AssaultLoader`), `assault-runtime.js`, `assault.js`,
   `addons.js`, `account-controls.js`, `rich-presence.js`, `history-export.js`,
   `html-export.js`, and the two licence texts (`licenses/Acorn-MIT.txt`,
   `licenses/Revenge-BSD-3-Clause.txt`).

With those in place, `bash ./gradlew :android:manager:assembleRelease
:android:loader:assembleRelease` produces the two APKs the release workflow copies as
`Hypercord-Manager.apk` and `Hypercord-Loader.apk`. `scripts/build_android.py` is
expected to find the wrapper when the jar is present and the `gradle` on the PATH
otherwise, so CI needs no wrapper jar of its own.

## The one honest claim

The rail, the themes and the plugin catalogue are already platform-agnostic: the
PWA fallback in `pwa/` runs in any modern Android browser with no APK at all, and
that is the only Android story this repository actually ships today.
