# Isolated addons (2.12.0)

## Implementation and acceptance status

The build adds React Native **Plugins** and **Themes** pages under Discord Settings → Assault. The authoritative project is `assault-main/source/`; its root modules are `plugins/`, `themes/`, `core/`, and `utils/`. `core/index.js` connects to the pinned upstream runtime and existing Android loader. `plugins/index.js`, `themes/index.js`, and `utils/store.js` are independent entry points for lifecycle, theme validation, and storage.

This is a candidate implementation, **not a production-certified Discord build**. Host regression tests and Android compilation do not establish live voice/audio, DMs, presence visibility, all theme surfaces, picker compatibility, accessibility, or crash-free operation on a device. The existing Manager downloads and patches device-specific Discord splits; its APK is not itself a patched Discord client. The target Discord version and device must be agreed and acceptance-tested before production installation.

## JavaScript input contract

Both `.js` and `.txt` contain the same UTF-8 JavaScript. No renaming is needed. Import through either library's **Import JavaScript file** button or use **Install from HTTPS URL** with the publisher's SHA-256 hash. Downloads are bounded, use platform HTTPS verification, reject redirects and mismatched checksums, and never inherit Discord authentication. The hash verifies the expected bytes; it does not certify the publisher's identity. Installed code is copied locally, starts disabled, and never auto-updates.

Files must export a single default object. See `plugins/examples/welcome.txt` and `themes/examples/midnight.txt`. The interpreter supports literal data, arrays, plain objects, const locals, if/else, conditional/logical expressions, primitive arithmetic/comparisons, return, and three lifecycle methods: `onStart(api)`, `onStop(api)`, `onSettingsChanged(api)`. It does not implement general JavaScript or existing Vendetta/Node plugin compatibility. Loops, imports, async functions, recursion, arbitrary function calls, prototype access, property getters and dynamic code generation are rejected.

The two user-provided scripts (`beefbot.txt` and `index.txt`) are Node.js selfbot applications. Their filesystem, HTTP server, account client and voice-library imports do not match this contract. They are treated as JavaScript and rejected by the addon loader. Import them into the separate [code runner](code-runner.md) as Node.js projects instead; their dependency and live-service compatibility still requires device testing. Their independent clients and unrestricted APIs cannot be used within this isolation model.

## API whitelist and isolation

Untrusted source is parsed with pinned Acorn, validated and interpreted as data. It is never passed to eval, Function, require, Hermes evaluation, or the upstream plugin evaluator. Both upstream external-plugin evaluators and legacy automatic plugin startup are blocked. Built-in runtime code remains trusted.

| Plugin call | Capability |
| --- | --- |
| `api.getSetting(name)` | Read the current plugin's validated settings |
| `api.getState(name, fallback)` | Copy a value from this plugin's persistent state |
| `api.setState(name, value)` | Write JSON data into this plugin's pending state transaction |
| `api.notify(text)` | Show a named Discord toast after the transaction commits |

There are **no native module functions exposed to addon code**. React, Metro, tokens, messages, voice, RPC, filesystem paths and network clients are not passed into the interpreter. Host-owned React Native components render plugin setting schemas. This avoids exposing React or native objects through plugin-generated components. Themes accept only the ten documented color tokens in `themes/index.js` and six-digit hex colors; they have no executable hooks or remote assets.

A failing hook rolls back its state and pending notifications and disables that plugin with an error on its card. Source is limited to 64 KiB of UTF-8 source, depth to 48 AST levels, execution to 5,000 node visits per hook, notifications to three per hook, state to 32 KiB per plugin, settings to 20 fields, and the library to 32 addons. Theme color propagation uses the pinned runtime's semantic color updater; Discord components outside that updater require device verification. App safe mode prevents activation.

## Persistence, exports and cloud backup

The device's private documents directory holds two journal slots. Operations serialize; a new revision is acknowledged only after exact read-back. An interrupted or malformed slot falls back to the previous valid revision. If both slots are damaged, startup reports an error and preserves the files. These checks detect incomplete writes, not malicious changes by a process that already controls the app's private storage. Android process-kill/power-loss behavior still requires device tests.

Backups include source, filenames/origins, metadata, install times, every plugin's settings and private state, inactive addons, activation preferences, all themes and the selected theme. Export waits for pending transactions. The native document writer closes the stream and reads the saved bytes back before reporting success. Failed writes attempt to delete the incomplete destination; a provider that refuses deletion may retain a failed file. The source journal is preserved. Android document-provider behavior cannot be guaranteed by host tests.

Restore requires an empty library and validates every entry before mutation. Restored plugins are disabled and the theme is reset, allowing deliberate activation. Existing legacy-plugin data is preserved separately and is not silently migrated or included in this new framework's backup.

Cloud backup is optional and explicit: provide an HTTPS endpoint that supports authenticated PUT and GET, then choose upload or restore. Local storage stays primary. Bearer credentials are not part of the journal or export; the temporary native request is removed after reading or bridge completion. Credentials briefly exist in app-private cache while an operation is pending; a process kill before cleanup can leave that request until next app startup. There is no automatic conflict merging or background sync. Remote storage access policy and encryption at rest are the operator's server configuration.

## Build and verification

Run `npm ci`, `npm run build:addons`, `npm test`, `npm run build`, and `python3 scripts/build_android.py` with Java 21 and SDK 36 configured. Gradle rebuilds `addons.js` from the module roots; Acorn's MIT license is packaged with the loader. Source packaging includes Xposed's entry point, ProGuard rules and all addon modules.

Device acceptance must cover import cancellation/permission errors, remote hash/network failures, backgrounding/rotation during picker use, repeated theme changes, large text/accessibility settings, multiple enabled plugins, force-stop/relaunch persistence, export/reimport equality, storage-full failures, voice join/leave/streaming, DM send/receive, RPC updates and safe-mode recovery. Record the exact Discord version, ABI, Android version and signing identity. Do not describe these checks as passed without exercising them.
