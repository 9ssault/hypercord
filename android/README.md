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
  plugin definition serves both platforms - no such Android folder exists yet, and
  this file is the only thing under `android/`;
* the manager is a small Android app (Kotlin) that fetches or accepts a Discord
  APK, verifies its version, injects the bundle,
* signs the result with a keystore the user controls, and installs it;
* direct Play distribution is not available for a modified client; expect
  sideloading, and expect Play Protect to warn.

## What is not done, and cannot be verified from here

- No APK is built, and none is claimed. This machine has no Discord APK, no
  Android SDK, no `apktool`, no `apksigner` and no JDK 25, so a build script
  written now would be untested code that fails on first contact with an APK -
  worse than no script.
- `rea` is available as an MCP server and its analysis commands are the only part
  of this we can use today: given an APK, `analyze-apk` is how we would learn
  which Discord version and which bundle layout we are dealing with.
- The interface a mobile loader expects from a plugin (Hermes bytecode bundle vs
  plain JS module, and its registration API) is **not verified** here. Until an
  APK and a loader are in hand, our plugin sources must be assumed to need an
  adapter, exactly as the desktop ones needed `src/loader.cjs`.

## The one honest claim

The rail, the themes and the plugin catalogue are already platform-agnostic: the
PWA fallback in `pwa/` runs in any modern Android browser with no APK at all, and
that is the only Android story this repository actually ships today.
