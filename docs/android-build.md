# Building the Android client

This is the recipe for `Hypercord-Manager.apk` and `Hypercord-Loader.apk`. Both
build from this tree today: the Gradle project is rooted at the repository root,
the wrapper is committed, the two upstream jars are checked in under
`android/deps/`, and `scripts/build_android.py` drives the whole thing and writes
down what it built.

The page this replaces said the opposite - that the tree could not produce an APK
until somebody staged four jars by hand, generated a wrapper, wrote nine sources,
created a pile of resources and wrote two manifests. Every one of those inputs is
in the tree now (the sources really were written, in `android/shared` and in both
modules; the resources and manifests are checked in), so the tables of missing
inputs are gone. What is genuinely still open is at the end of this page, and it
is short.

## What the two APKs are

| Module | Gradle name | What it is | Published as |
| --- | --- | --- | --- |
| `android/manager` | `:android:manager` | The app the user installs: it downloads a Discord version it supports, patches it with the loader, signs the result and installs it as a separate app | `Hypercord-Manager.apk` |
| `android/loader` | `:android:loader` | The code that runs *inside* Discord: the runtime, the addon interpreter bridge and the scripts capture. It ships as an APK because the asset bundle is the deliverable and Xposed/LSPatch consumes it that way | `Hypercord-Loader.apk` |

Neither is a fork of Discord. Discord's own APK is never redistributed: the manager
patches a copy the user downloads, exactly as Revenge Manager, KettuManager and
rainManager do.

The two modules are not independent builds, in one direction: the manager's
`bundleReleaseLoader` / `bundleDebugLoader` task (registered per variant) assembles
`:android:loader` for the *same* variant and copies its APK into the manager's
assets as `loader.apk`, which is how
the manager carries the code it installs. That task insists on finding exactly one
APK in the loader's output directory for that variant - it is the reason the
release job can build the loader unsigned (`loader-release-unsigned.apk`) without
the manager's build file having to name either spelling.

## Toolchain

| Tool | Version | Why that one |
| --- | --- | --- |
| JDK | **21** | `android/manager/build.gradle` sets `sourceCompatibility JavaVersion.VERSION_21` and the loader is on 17, so 21 compiles both. `scripts/build_android.py` reads the `java` on `PATH` and refuses an older one by name, because with an older JDK Gradle runs a minute of other tasks before javac says `invalid source release: 21`, which reads as a bad source file |
| Android SDK | platform **android-36**, build-tools **36.0.0**, platform-tools | `compileSdk` and `targetSdk` are 36 in both modules. AGP fetches a missing platform itself when the SDK licences are accepted, so an SDK with only an older platform still builds |
| Gradle | the wrapper in this tree: **8.13** | `gradle/wrapper/gradle-wrapper.properties` pins 8.13 and `gradle/wrapper/gradle-wrapper.jar` is committed, so `./gradlew` / `gradlew.bat` work with no Gradle installed. The root `build.gradle` declares AGP **8.11.1**, which is the pairing this tree was ported with |
| Python | 3.9+ | `scripts/patch_runtime.py` and the packaging helpers. The loader's `runtimeAssets` task runs the patch itself and finds its own interpreter (see below) |
| Node | 20 | the suites the APK job runs (`npm run test:units`, `test:updater`, `test:preload`) |

The interpreter is worth knowing about because it is the one thing that is *not*
the same everywhere: the loader's task tries `python3`, then `python`, then
`py -3`, and runs each candidate rather than looking it up. On Windows `python3`
is usually the Microsoft Store's execution alias - present on `PATH`, failing
with 9009 when run - and its complaint ("Python was not found...") contains the
word Python, so a check that merely greps for that word accepts a name that
cannot run anything. A candidate only counts when it answers with a version.

## The recipe, in order

### 1. Install the SDK packages

```bash
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
export ANDROID_HOME="$HOME/Android/Sdk"        # or ANDROID_SDK_ROOT
```

`preflight` refuses to start without one of those two variables, because AGP
without an SDK fails much later and much less clearly.

### 2. Nothing to stage by hand

The two upstream jars are checked in, and each is used as what it is rather than
copied into a `libs/` directory:

* `android/deps/lspatch.jar` - LSPatch's patcher and its injection runtime. The
  manager unpacks the `assets/` half into its own assets and makes a
  `lspatch-code.jar` from the rest (minus `ApkPatcher.class`, which this tree
  vendors its own copy of, and minus `META-INF`), which is what the
  `implementation files(patcherCode...)` line consumes.
* `android/deps/xposed-api.jar` - the API the loader compiles against
  (`compileOnly`); the injected process provides it at runtime.

`android/loader/src/main/assets/revenge.js` is the third upstream input: the
runtime the loader patches into `assault-runtime.js`. Refreshing any of them is
`scripts/fetch_android_deps.py`, which downloads only what is missing, verifies
every SHA-256 it writes against `scripts/android-dependencies.json`, and refuses
anything that does not match - an unpinned upstream is how a changed runtime ships
unreviewed. It also offers `--check` (verify, download nothing) and `--force`. An
entry with no `url` in that file is either checked in or resolved by Gradle, and is
reported as skipped rather than fetched.

### 3. Build

```bash
python scripts/build_android.py                     # the manager, release variant
python scripts/build_android.py --variant debug      # unsigned debug APKs
python scripts/build_android.py --all-variants       # manager and loader, release
python scripts/build_android.py --modules manager,loader --variant debug
python scripts/build_android.py --dry-run            # print the plan, run nothing
```

Other flags: `--output-dir` (default `release/candidate`), `--acceptance` (default
`release/acceptance.json`) and `--gradle` (default: this tree's `./gradlew` when it
is there, otherwise whatever `gradle` is on `PATH`).

Each module's APK lands in `android/<module>/build/outputs/apk/<variant>/` and is
copied to `release/candidate/<module>-<variant>.apk`. The copy is not the point of
the script: it hashes the artifact it produced, checks that it is an APK this build
can be believed about, and writes `release/acceptance.json` - the artifacts and
their digests, the tool versions, the commit, the checks that ran, the checks that
could *not* run, and every pinned input that is missing or unpinned. A build that
exits 0 with no APK on disk is exactly the failure the record exists to catch, so
that case exits non-zero.

### 4. Signing

Release signing material comes from the environment and is never stored in Git:

```bash
export HYPERCORD_KEYSTORE_PATH=/path/to/manager.p12
export HYPERCORD_SIGNING_PASSWORD=...
export HYPERCORD_KEY_ALIAS=hypercord          # optional, this is the default
export HYPERCORD_KEY_PASSWORD=...             # optional, defaults to the password above
```

Without a keystore the release variant refuses to run, and it refuses *before* any
release work: `android/signing.gradle` hangs a `requireReleaseSigning` task off
`preReleaseBuild` and throws with the names of the two variables, because AGP
quietly omits its own `validateSigningRelease` when nothing is configured.

An unsigned release on purpose is asked for with `HYPERCORD_ALLOW_UNSIGNED=1`, and
the build says so in its log. That APK installs, and it cannot update over an
install signed with a different key; Android simply refuses the update. It must not
be published, which is why `release/acceptance.json` records each artifact as
signed or as "unsigned: no keystore was provided".

### 5. Publish

Both workflows in `.github/workflows/` set up JDK 21 (`release.yml`'s APK job and
`android-release.yml`), run `python3 scripts/build_android.py --all-variants`, then
`python3 scripts/candidate_artifacts.py collect release/candidate`, copy the two
candidates to `release/Hypercord-Manager.apk` and `release/Hypercord-Loader.apk`,
write `SHA256SUMS` over what was actually produced, and attach those with
`release/acceptance.json`.

Keep the two records in step: the packaging step reads the accepted artifacts and
their digests from the record's **top level** - the same place the build driver puts
them. A record that only described them inside a `candidate` block was one
`pack_release_artifacts.py` could not pack from: it refused with "the record lists
no artifacts" and the job ended with no APK attached.

## What the build checks before Gradle is started

`preflight` in `scripts/build_android.py` is what turns most of this page's failure
modes into one sentence each, before a Gradle log can bury them:

* `settings.gradle` exists at the repository root and `include`s both
  `:android:manager` and `:android:loader` - the Gradle project is rooted here, not
  in `android/`, which is what makes the module paths above the right ones;
* the `gradle` it was given can be run, and the `java` on `PATH` is 21 or newer;
* both module `build.gradle` files exist;
* the loader's asset tree does not contain a file the Gradle task also injects
  (two sources for one bundle entry fail with `no duplicate handling strategy has
  been set`);
* no resource is defined twice across the module's own `res/` and the shared
  `android/branding/res` (AGP reports that as `Duplicate resources` after
  compiling everything around it);
* every resource a manifest names is provided by one of those directories;
* `ANDROID_HOME` or `ANDROID_SDK_ROOT` is set.

## The loader's asset bundle

`android/loader/src/main/assets/` holds the bundle the loader injects into the
patched client: `xposed_init`, `addons.js` (the addon runtime, generated by
`scripts/build_addons.mjs` from `core/`, `utils/`, `plugins/` and `themes/`),
`assault.js`, `account-controls.js`, `rich-presence.js`, `history-export.js`,
`html-export.js` - and `revenge.js`, the upstream runtime that is an input rather
than a member of the bundle.

The `runtimeAssets` task assembles what actually ships: it syncs that directory
(minus `revenge.js`), copies `android/licenses/Revenge-BSD-3-Clause.txt` in beside
them, runs `scripts/patch_runtime.py` to write `assault-runtime.js`, and then
renames the labels the runtime draws about itself - failing the build by name if
the upstream text it expects is not there, so a runtime that silently stopped being
branded cannot ship. The module's own assets source directory is emptied in favour
of that generated one, so the bundle has exactly one source. `build_android.py`
checks the result as a contract: a missing or empty file, a wrong `xposed_init`, a
duplicate runtime or an unlisted file under `assets/` is a refusal, and the largest
asset is capped.

## Plugins and themes inside the APK

The owner's requirement is that the APK ships the plugins and themes rather than
fetching everything at runtime. That is `assets/addons.js`, and it needs to be
understood exactly, because "all plugins" means two different things here.

**What `addons.js` is.** The JavaScript half of the client - the same sources the
phone client executes: `core/` (the addon manager, the screens, the script
screens), `utils/` (the store, validation), `plugins/` (the sandbox interpreter and
the addon manager) and `themes/` (the theme tokens and `nativeTheme`). Inside the
client, `core/index.js` installs `globalThis.__ASSAULT_ADDONS__`, which is what the
patched Discord runtime calls to build the Addons, Themes and Code runner pages.

**What actually runs.** Only this client's own addon dialect (see
`docs/addon-framework.md`): one `export default`, literal data, no loops, no
imports, `api.getSetting/getState/setState/notify`. So what ships as *runnable*
content is the bundled examples (`plugins/examples/welcome.txt`,
`themes/examples/amoled.txt`) and `themes/index.js`, the ten-token validator.

**What does not run, and must not be claimed to.** The 371-entry vendored catalogue
(`plugins/manifest.json`, built by `scripts/vendor.mjs` from Vencord and Equicord)
is TypeScript: its bodies are `.ts`/`.tsx` and the plugin host refuses them by
design. Shipping it inside the APK gives the phone client a *browseable catalogue*,
not 371 working plugins. It is not shipped today - `android/manager/src/main/assets/`
carries only `script_runner.py` - and shipping it would mean an
`addon-catalogue.json` plus a reader pointed at it, which does not exist either.
The honest half of "all plugins and themes are in the APK" is that the file can
ship today and the UI that lists it cannot, because the sandbox cannot execute
another ecosystem's format whatever the catalogue says.

For completeness, the three ways the phone client can already reach addons without
a bundled catalogue: the bundled examples, importing a `.txt`/`.js` file through
the manager's Import, and the source catalogue in `core/sources.js` (third-party
sources, listed and openable, installable only if they happen to be written in this
dialect).

## Still open

| Open | Why it matters |
| --- | --- |
| A keystore for the release pipeline | Without one, `--variant release` refuses (or builds unsigned when asked); an unsigned APK cannot update over a signed install and must not be published |
| `android/manager/src/main/assets/addon-catalogue.json` and its reader | the browseable catalogue described above; the file can ship, the screen that lists it does not exist yet |
| Unpinned inputs | `build_android.py` reports what is present but has no checksum in `scripts/android-dependencies.json` - today `scripts/runtime-patches/storage-hooks.js` and the generated `android/loader/src/main/assets/addons.js` - in `dependency_gaps`, rather than treating them as trusted |
| The Android artifacts' licence | `package.json` says `GPL-3.0-or-later` and the APKs are distributed under it; there is a copy of the Revenge notice for the runtime, and none of the GPL text at `android/LICENSE` or the repository root |
