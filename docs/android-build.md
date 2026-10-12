# Building the Android client

This is the recipe for `Hypercord-Manager.apk` and `Hypercord-Loader.apk`, and the
complete list of what this tree is missing before either can exist. Nothing here is
a plan to be written later: the Gradle project, the build driver
(`scripts/build_android.py`), the candidate/acceptance helpers and the CI job all
exist and are checked in. What is absent is *inputs* - other projects' artifacts,
and source files this repository refers to but does not contain.

Read the "What is missing from this tree" table before believing an APK is one
command away. `scripts/android-dependencies.json` records thirty-three inputs and
marks **twenty-eight of them `required: true`** - every one is either a file
somebody stages or source somebody writes, and five of them are other projects'
code (the Revenge runtime, apkzlib, ManifestEditor and LSPatch's two modules).

## What the two APKs are

| Module | Gradle name | What it is | Published as |
| --- | --- | --- | --- |
| `android/manager` | `:android:manager` | The app the user installs: it downloads a Discord version it supports, patches it with the loader, signs the result and installs it as a separate app | `Hypercord-Manager.apk` |
| `android/loader` | `:android:loader` | The code that runs *inside* Discord: the runtime, the addon interpreter bridge and the scripts capture. It ships as an APK because the asset bundle is the deliverable and Xposed/LSPatch consumes it that way | `Hypercord-Loader.apk` |

Neither is a fork of Discord. Discord's own APK is never redistributed: the manager
patches a copy the user downloads, exactly as Revenge Manager, KettuManager and
rainManager do.

## Toolchain

| Tool | Version | Why that one |
| --- | --- | --- |
| JDK | **21** | The module builds set `sourceCompatibility JavaVersion.VERSION_21`, and `.github/workflows/release.yml` installs 21 (the older `android-release.yml` said 17 and was wrong) |
| Android SDK | platform **android-36**, build-tools **36.0.0**, platform-tools | `compileSdk`/`targetSdk` are 36 in both modules; AGP 8.9 is what compiles against 36 |
| Gradle | **8.11.1** (wrapper), or the SDK's `gradle` on `PATH` | `gradle/wrapper/gradle-wrapper.properties` pins 8.11.1, the version that pairs with AGP 8.9.0. There is **no `gradle-wrapper.jar` in the tree** - it is a binary - so `./gradlew` fails until somebody runs the one-off step below |
| Python | **3.9+** (CI uses 3.11) | `scripts/build_android.py` and the packaging helpers |
| Node | 20 | The suites the APK job runs (`npm run test:units`, `test:updater`, `test:preload`) |

## The recipe, in order

### 1. Install the SDK packages

```bash
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
export ANDROID_HOME="$HOME/Android/Sdk"        # or ANDROID_SDK_ROOT
```

### 2. Generate the wrapper once and commit it

`gradle/wrapper/gradle-wrapper.properties` is checked in; the jar and the scripts
are not, and cannot be written by hand.

```bash
gradle wrapper --gradle-version 8.11.1
```

Commit `gradlew`, `gradlew.bat` and `gradle/wrapper/gradle-wrapper.jar` together.
CI does not need this step: the APK job uses the `gradle` on the runner's `PATH`
(the workflow reports what it found before building).

### 3. Stage the four jars

`android/manager/build.gradle` declares them as commented `files(...)` lines,
because none of their class names resolves from Maven as written. Put the jars in
`android/manager/libs/` and uncomment:

```groovy
implementation files('libs/apkzlib.jar')
implementation files('libs/ManifestEditor.jar')
implementation files('libs/lspatch-share.jar')
implementation files('libs/lspatch-patch.jar')
```

Where each one comes from, and why the coordinate is not simply written down:

* **apkzlib** (`com.android.tools.build.apkzlib.*`) - the AGP project's own zip and
  signing library; `ApkPatcher` uses `ZFile`, `ZFileOptions`, `StoredEntry`,
  `NestedZip`, `AlignmentRules`, `SigningExtension` and `SigningOptions` to rewrite
  and re-sign the patched client. It is published from Google's Maven repository
  under the `com.android.tools.build` group, but the version has to be chosen
  deliberately and matched to the rest of the toolchain - which is why the module
  takes it as a file and says so, rather than pinning a version invented here. A
  copy also ships inside some build-tools releases.
* **ManifestEditor** (`com.wind.meditor.core/property/utils`) - WindySha's
  ManifestEditor, used to rewrite the client's manifest (package visibility, the
  attributes the patch needs). Distributed through JitPack; the coordinate depends
  on the fork/commit, so the jar is staged rather than guessed.
* **LSPatch `share` and `patch`** (`org.lsposed.lspatch.share.*`,
  `org.lsposed.patch.util.*`) - LSPatch publishes no Maven artifact under these
  packages; these are two of its own Gradle modules (`:share`, `:patch`). Either
  build them from the LSPatch sources (GPL-3.0) or take the classes from a release
  build. `Constants`, `LSPConfig` and `PatchConfig` come from `share`;
  `ApkSignatureHelper`, `Logger` and `ManifestParser` come from `patch`.

Resolvable, and already declared in the module: `com.google.code.gson:gson:2.11.0`,
`commons-io:commons-io:2.16.1`, and the loader's
`de.robv.android.xposed:api:82` (`compileOnly`, resolved from
`https://api.xposed.info/`, which is why that repository is in `settings.gradle`).
`org.json` comes from the platform on a device.

### 4. Write the nine sources the modules import but the tree does not define

These are compile errors, not packaging problems. They are listed in the table
below with the members each caller uses. `settings.gradle` deliberately does *not*
declare `:android:shared`: a module with no sources replaces "package
app.assault.shared does not exist" - which names the problem - with a Gradle error
about an empty project. Add `include ':android:shared'` the moment those classes
exist, and point both modules at it.

### 5. Create the manager's resources

`android/manager/src/main/res/` does not exist, and the manifest asks for
`@mipmap/ic_launcher` (twice: `icon` and `roundIcon`) and
`@xml/data_extraction_rules`. The manifest merger fails on the first missing one.
Nothing in the module draws from XML - every screen is built programmatically - so
two resources are the whole requirement:

```
android/manager/src/main/res/mipmap-anydpi-v26/ic_launcher.xml   (adaptive icon: a black tile, matching build/icon.*)
android/manager/src/main/res/xml/data_extraction_rules.xml       (Android 12+ backup rules; allowBackup is false, and this says what a transfer would take)
android/manager/src/main/res/values/colors.xml                   (only if the adaptive icon references a colour)
```

The loader needs **one**: its manifest names `@xml/data_extraction_rules` the same way,
and that file belongs in the module's own tree at
`android/loader/src/main/res/xml/data_extraction_rules.xml` - not in
`android/branding/res/`, which both modules add to their resource source dirs and where
the manager's copy of the same resource already lives. AAPT reports a missing one as
`resource xml/data_extraction_rules (aka app.assault.loader:xml/data_extraction_rules)
not found`, hundreds of merge lines into a Gradle log; `scripts/build_android.py` now
resolves every resource a manifest names against those directories in `preflight`, so the
mismatch is named before Gradle is started.

The other half of that check is the duplicate: a resource the shared directory and a
module both define is not shadowed, it fails the merge with `Duplicate resources` naming
both files. The manager's own `drawable/ic_launcher.xml` - the header glyph - was exactly
that, and the header now takes the shared one, as the ported client does. `preflight`
reports the pair before Gradle runs, and `tests/manifest-resources.test.mjs` holds it.

### 6. Write the loader's manifest

`android/loader/src/main/` contains `java/` and nothing else. An application module
without a manifest does not build. It must declare the package
`app.assault.loader`, the Xposed entry points (`xposedmodule`, `xposedminversion`,
`xposeddescription` meta-data), and the framework attributes an application needs:
the launcher icon from `android/branding/res`, which both modules share, and the
Android 12+ backup rules from the module's own `res/xml/` (step 5). No activity and no
launcher of its own - the loader runs inside the client it patches.

### 7. Assemble the loader's ten assets

This is the bundle the loader injects into the patched client, and it is a contract:
`scripts/build_android.py` refuses a bundle with a file missing, a file empty, a
wrong `xposed_init`, a duplicate runtime, or anything under `assets/` that is not on
the list, and caps the largest asset at 16 MiB.

```
android/loader/src/main/assets/
  xposed_init                      app.assault.loader.AssaultLoader   (the string, exactly)
  addons.js                        the addon runtime + the plugins and themes (see below)
  assault-runtime.js               the patched Revenge runtime (step 8)
  assault.js                       capture
  account-controls.js              account controls
  rich-presence.js                 rich presence
  history-export.js                history export
  html-export.js                   html export
  licenses/Acorn-MIT.txt           Acorn (MIT)
  licenses/Revenge-BSD-3-Clause.txt Revenge (BSD-3-Clause)
```

None of the ten exists anywhere in this repository today - not even `addons.js`,
which the pin file called "generated". Nothing generates it: the assembly step is
one of the missing inputs below, not an oversight in the build files.

The bundle as the build checks it today is the list in `scripts/build_android.py`
(`REQUIRED_LOADER_ASSETS`, nine entries): the Acorn notice was dropped, because nothing
in this client uses Acorn, and the licence text is copied into the bundle by the loader's
Gradle task from `android/licenses/Revenge-BSD-3-Clause.txt`. Nothing under
`src/main/assets/licenses/` any more: a second source for one bundle entry fails the
build with `no duplicate handling strategy has been set`, and both that and the
resource resolution above are checked by `tests/manifest-resources.test.mjs`.

### 8. Produce the runtime and record its checksum

`assault-runtime.js` is `vendor/revenge/revenge.js` with the reviewed patches in
`scripts/patch_runtime.py` applied - storage hooks, MMKV backend options, the addon
pages wired into Discord's settings, and the legacy plugin evaluator disabled:

```bash
curl -L -o vendor/revenge/revenge.js <the Revenge runtime release>
sha256sum vendor/revenge/revenge.js     # record it in scripts/android-dependencies.json
python3 scripts/patch_runtime.py vendor/revenge/revenge.js android/loader/src/main/assets/assault-runtime.js
```

The patch step refuses to run while `sha256` is `null` in the pin file, and it also
reads `scripts/runtime-patches/storage-hooks.js`, which is **not in the tree** (see
the table). Patching an unpinned upstream is how an unreviewed upstream change
ships, which is why the refusal is deliberate.

### 9. Build

```bash
export HYPERCORD_ANDROID_VERSION=0.2.4        # prints as BuildConfig.VERSION_NAME
export HYPERCORD_KEYSTORE_PATH=/path/to/manager.p12
export HYPERCORD_SIGNING_PASSWORD=...         # never printed; redacted in every log
python3 scripts/build_android.py --all-variants
python3 scripts/candidate_artifacts.py collect release/candidate
```

The build driver writes `release/acceptance.json`: the artifacts and their digests,
tool versions, the commit, the checks that ran and the ones that could not run, and
every `required` pin still missing. A build that produces no APK exits non-zero
after reading the disk - a Gradle exit code of 0 with nothing on disk is the failure
this exists to catch.

Without the signing variables the release APK is built **unsigned** and says so.
An unsigned APK installs, but it cannot update over a signed install; Android
refuses the update. The workflow prints `signing: UNSIGNED ...` in that case rather
than letting an unsigned artifact pass as a signed one.

### 10. Publish

The release workflow copies `release/candidate/manager-release.apk` to
`release/Hypercord-Manager.apk`, the loader likewise, writes `SHA256SUMS` over what
was actually produced (no APK at all is a hard failure), and attaches them with
`release/acceptance.json`. That job is **off by default** - `workflow_dispatch`
takes `build_apk`, and a tag push skips it - because it cannot succeed while the
inputs below are absent, and the publish job states the skip instead of pretending
an APK was built.

## Plugins and themes inside the APK

The owner's requirement is that the APK ships the plugins and themes rather than
fetching everything at runtime. That is `assets/addons.js`, and it needs to be
understood exactly, because "all plugins" means two different things here.

**What `addons.js` is.** The JavaScript half of the client - the same sources the
phone client executes: `core/` (the addon manager, the screens, the script
screens), `utils/` (the journal, validation, the native bridge), `plugins/` (the
sandbox interpreter and the addon manager) and `themes/` (the theme tokens and
`nativeTheme`). It is assembled from those module roots, which is the mapping the
pin file has always carried. Inside the client, `core/index.js` installs
`globalThis.__ASSAULT_ADDONS__`, which is what the patched Discord runtime calls to
build the Addons, Themes and Code runner pages (`scripts/patch_runtime.py` wires
those three settings pages to `assaultAddonPage("plugin"|"theme"|"script")`).

**What actually runs.** Only this client's own addon dialect (see
`docs/addon-framework.md`): one `export default`, literal data, no loops, no
imports, `api.getSetting/getState/setState/notify`. So what ships as *runnable*
content is:

```
plugins/examples/welcome.txt     a plugin in the dialect
themes/examples/amoled.txt       the AMOLED default theme
themes/index.js                  the ten-token validator and nativeTheme
```

**What does not run, and must not be claimed to.** The 371-entry vendored
catalogue (`plugins/manifest.json`, built by `scripts/vendor.mjs` from Vencord and
Equicord) is TypeScript: its bodies are `.ts`/`.tsx` and the plugin host refuses
them by design. Shipping it inside the APK gives the phone client a *browseable
catalogue*, not 371 working plugins. If it is shipped, it is as a separate asset -
`android/manager/src/main/assets/addon-catalogue.json` - and the reader has to be
pointed at it (`core/screens.js` currently has no catalogue source on the phone
side). That reader change is **not** in this slice and is the honest half of "all
plugins and themes are in the APK": the file can ship today, the UI that lists it
cannot, because the sandbox cannot execute another ecosystem's format whatever the
catalogue says.

For completeness, the three ways the phone client can already reach addons without
a bundled catalogue: the bundled examples, importing a `.txt`/`.js` file through
the manager's Import, and the source catalogue in `addon-sources.json` /
`core/sources.js` (60 third-party sources, listed and openable, installable only if
they happen to be written in this dialect).

## What is missing from this tree

Twenty-eight of the thirty-three entries in `scripts/android-dependencies.json` are
`required: true`, which is the file the CI job reads before it lets Gradle start.
Every path below is checked by `os.path.exists`, so each one is either a file
somebody stages or source somebody writes. The five that are not required are the
three Maven coordinates Gradle resolves on its own (Gson, Commons IO, the Xposed
API), the browse-only addon catalogue, and the repository licence text.

### Source the modules import and nobody defines (9 files)

| Missing | Path it must live at | Blocks | What the callers need |
| --- | --- | --- | --- |
| `app.assault.shared.AccountSettings` | `android/shared/src/main/java/app/assault/shared/AccountSettings.java` | manager + loader | `AssaultLoader` and `ManagerActivity` both import it |
| `app.assault.shared.CommandGuide` | `.../shared/CommandGuide.java` | manager | `ManagerActivity` command guide screen |
| `app.assault.shared.RichPresence` | `.../shared/RichPresence.java` | manager | `ManagerActivity` presence builder |
| `ClientEngine` | `android/manager/src/main/java/app/assault/manager/ClientEngine.java` | manager | `CLIENT`, `installed`, `prepared`, `needsUpdate`, `beginPrepare`, `prepareReserved`, `cancel`, `clearDownloads`, `beginInstall`, `verifyPrepared`, `busy`, `installing`, `progress` - the whole download/patch/install engine |
| `ReleaseSource` | `.../manager/ReleaseSource.java` | manager | `latest()`, `copy(in,out)`, `readBounded(in,n)` - the Discord release feed |
| `ManagerUpdater` | `.../manager/ManagerUpdater.java` | manager | `prepared(this)`, `check(this)` - the manager's own updater |
| `InstallReceiver` | `.../manager/InstallReceiver.java` | manager | declared in `AndroidManifest.xml` and started by `ManagerActivity` with action `app.assault.manager.INSTALL_RESULT` |
| `UpdateJob` | `.../manager/UpdateJob.java` | manager | declared in the manifest and scheduled as a `JobInfo` service (id 26000) |
| `AddonFiles` | `android/loader/src/main/java/app/assault/loader/AddonFiles.java` | loader | `AddonFiles.publish(File, byte[])`, used by `AddonDocuments` and `ScriptDocuments` to hand a result file back |

`settings.gradle` must also gain `include ':android:shared'` for the first three,
and that module needs its own `build.gradle` (library plugin).

### Upstream artifacts and the patch text (5)

| Missing | Path it must live at | Blocks | Source |
| --- | --- | --- | --- |
| Revenge runtime | `vendor/revenge/revenge.js` | loader (and the runtime patch step) | upstream Revenge release; **checksum must be recorded** before `patch_runtime.py` will patch it |
| Storage hooks patch | `scripts/runtime-patches/storage-hooks.js` | runtime patch step | the reviewed patch text `patch_runtime.py` splices into the runtime; absent, so step 8 fails with a `FileNotFoundError` |
| apkzlib | `android/manager/libs/apkzlib.jar` | manager | AGP's own library (Google Maven, version to be pinned) |
| ManifestEditor | `android/manager/libs/ManifestEditor.jar` | manager | WindySha's ManifestEditor |
| LSPatch `share` + `patch` | `android/manager/libs/lspatch-share.jar`, `.../lspatch-patch.jar` | manager | built from the LSPatch sources (GPL-3.0); not on Maven under these packages |

### Resources, manifests and the loader's ten assets

| Missing | Path it must live at | Blocks | Note |
| --- | --- | --- | --- |
| Manager resources | `android/manager/src/main/res/` | manager | `@mipmap/ic_launcher`, `@xml/data_extraction_rules` |
| Loader manifest | `android/loader/src/main/AndroidManifest.xml` | loader | package + Xposed meta-data only |
| `xposed_init` | `android/loader/src/main/assets/xposed_init` | loader | content exactly `app.assault.loader.AssaultLoader` |
| `addons.js` | `android/loader/src/main/assets/addons.js` | loader | the JS module roots; nothing generates it today |
| `assault-runtime.js` | `android/loader/src/main/assets/assault-runtime.js` | loader | output of step 8; the 16 MiB cap applies to it |
| `assault.js` | `android/loader/src/main/assets/assault.js` | loader | capture |
| `account-controls.js` | `android/loader/src/main/assets/account-controls.js` | loader | account controls |
| `rich-presence.js` | `android/loader/src/main/assets/rich-presence.js` | loader | rich presence |
| `history-export.js`, `html-export.js` | `android/loader/src/main/assets/` | loader | the two export scripts |
| Loader resource | `android/loader/src/main/res/xml/data_extraction_rules.xml` | loader | the loader's manifest names `@xml/data_extraction_rules`; without it the resource link fails |
| Licence | the vendored `android/licenses/Revenge-BSD-3-Clause.txt` | loader | required by the asset rules; the Gradle task copies it into the bundle, so the asset tree must not carry a second copy |

### Not build blockers, but acceptance gaps

| Gap | Why it matters |
| --- | --- |
| `android/manager/src/main/assets/addon-catalogue.json` | the owner wants plugins and themes inside the APK; this is the browseable catalogue, and its reader does not exist yet (see above) |
| `android/LICENSE` (and none at the repository root) | the Android artifacts are distributed under GPL-3.0-or-later without a copy of the licence; `package.json` says `GPL-3.0-or-later` and nothing else does |
| `android/manager/src/main/assets/script_runner.py` | present, checksum **unpinned** - `build_android.py` reports it as a gap rather than trusting it |

## Two inconsistencies to settle before the first CI run

1. **The Gradle invocation does not match the project names.** `settings.gradle`
   declares `:android:manager` and `:android:loader` (root-relative), while
   `scripts/build_android.py` runs `gradle --project-dir android :manager:assembleRelease`.
   `--project-dir android` makes Gradle look for a build rooted in `android/`, where
   it will not find the root `settings.gradle`, and `:manager` is not a declared
   project path under either layout. One of the two has to change - either the
   script drops `--project-dir` and uses `:android:manager`, or `settings.gradle`
   moves under `android/` with `include ':manager'`. `find_built_apk` expects
   `android/<module>/build/outputs/apk/<variant>/`, which fits the first option.
2. **`gradle/wrapper/gradle-wrapper.properties` exists without the wrapper jar.**
   Step 2 fixes it; until then only the `gradle` on `PATH` works, which is what CI
   relies on.

Both are recorded here rather than fixed because the files belong to other slices
(`scripts/build_android.py`, `settings.gradle`) and guessing which convention wins
is how a build ends up with two of them.
