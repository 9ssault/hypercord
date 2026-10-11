#!/usr/bin/env python3
"""Apply reviewed fixes to the checksum-pinned runtime without editing its download."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(source, original, replacement):
    if source.count(original) != 1:
        raise ValueError(f"Expected exactly one runtime patch target: {original[:100]}")
    return source.replace(original, replacement, 1)


def patch_runtime(data):
    dependencies = json.loads((ROOT / "scripts/android-dependencies.json").read_text())
    runtime = next(item for item in dependencies if item["path"].endswith("/revenge.js"))
    if hashlib.sha256(data).hexdigest() != runtime["sha256"]:
        raise ValueError("Runtime checksum mismatch; review patches before changing upstream")
    source = data.decode("utf-8")
    start = source.index("  function useProxy(storage) {")
    end = source.index("  var import_react_native, emitterSymbol", start)
    source = source[:start] + (ROOT / "scripts/runtime-patches/storage-hooks.js").read_text() + source[end:]
    source = replace_once(source, 'if (typeof value === "object") {\n            if (childrens.has(value))',
                          'if (value !== null && typeof value === "object") {\n            if (childrens.has(value))')
    source = replace_once(source, 'src_default = () => _async_to_generator(function* () {\n        yield Promise.all([',
                          'src_default = () => _async_to_generator(function* () {\n'
                          '        yield awaitStorage(settings, loaderConfig, themes, fonts, VdPluginManager.plugins);\n'
                          '        yield Promise.all([')
    source = replace_once(source, 'useProxy(VdPluginManager.plugins[vdPlugin.id]);',
                          'useProxy(VdPluginManager.plugins);')
    source = replace_once(source, 'createMMKVBackend("VENDETTA_SETTINGS")',
                          'createMMKVBackend("VENDETTA_SETTINGS", { developerSettings: false })')
    # These wrappers only forwarded their arguments; keep the same public names.
    for name, argument in (("createProxy", "target"), ("useProxy", "_storage"),
                           ("createStorage", "backend"), ("wrapSync", "store")):
        source = replace_once(source, f'{name}: ({argument}) => {name}({argument}),', f'{name},')
    source = replace_once(source, '            awaitSyncWrapper: (store) => awaitStorage(store),',
                          '            getStorageState,\n            useStorageState,\n'
                          '            awaitSyncWrapper: (store) => awaitStorage(store),')
    source = replace_once(source, 'var { ClientInfoManager } = (init_modules(), __toCommonJS(modules_exports));',
                          'var buildNumber = "unknown";\n'
                          '        try {\n'
                          '          var { NativeClientInfoModule } = (init_modules(), __toCommonJS(modules_exports));\n'
                          '          buildNumber = NativeClientInfoModule?.getConstants?.()?.Build ?? "unknown";\n'
                          '        } catch {}')
    source = replace_once(source, 'Build Number: ${ClientInfoManager.getConstants().Build}', 'Build Number: ${buildNumber}')
    source = replace_once(source, '  function initSettings() {',
                          '  function assaultAddonPage(kind) {\n'
                          '    if (globalThis.__ASSAULT_ADDONS__) return globalThis.__ASSAULT_ADDONS__.page(kind);\n'
                          '    return { default: () => globalThis.React.createElement(globalThis.ReactNative.Text, { accessibilityRole: "alert", style: { padding: 24, backgroundColor: "#1e1f22", color: "#ffb0b8", fontSize: 16 } }, "Addons are unavailable. Restart Discord or reinstall the matching Assault loader.") };\n'
                          '  }\n'
                          '  function initSettings() {')
    source = replace_once(source, '          key: "BUNNY_THEMES",',
                          '          key: "ASSAULT_SCRIPTS",\n'
                          '          title: () => "Code runner",\n'
                          '          icon: findAssetId("PuzzlePieceIcon"),\n'
                          '          render: () => Promise.resolve(assaultAddonPage("script"))\n'
                          '        }, {\n'
                          '          key: "BUNNY_THEMES",')
    # Route both settings pages to the isolated addon managers. No legacy external
    # plugin evaluator is allowed to bypass this boundary, including auto-start.
    source = replace_once(source, '        evalPlugin(plugin) {',
                          '        evalPlugin(plugin) { throw new Error("Legacy plugins require porting to the Assault sandbox API.");')
    source = replace_once(source, '      if (isExternalPlugin(manifest)) {\n        try {',
                          '      if (isExternalPlugin(manifest)) {\n        throw new Error("External plugins must use the Assault sandbox API.");\n        try {')
    source = replace_once(source, 'render: () => Promise.resolve().then(() => (init_Plugins(), Plugins_exports))',
                          'render: () => Promise.resolve(assaultAddonPage("plugin"))')
    source = replace_once(source, 'render: () => Promise.resolve().then(() => (init_Themes(), Themes_exports))',
                          'render: () => Promise.resolve(assaultAddonPage("theme"))')
    source = replace_once(source, '        globalThis.bunny = lib_exports;',
                          '        globalThis.bunny = lib_exports;\n'
                          '        yield globalThis.__ASSAULT_ADDONS__?.initialize(globalThis.vendetta, (data) => updateBunnyColor(data, { update: true }), NativeFileModule);')
    source = replace_once(source, '        VdPluginManager.initPlugins().then((u) => unload.push(u)).catch(() => alert("Failed to initialize Vendetta plugins"));',
                          '        // Legacy external plugin auto-start is disabled; sources must be ported.')
    source = replace_once(source, '        updateThemes().catch((e) => console.error("Failed to update themes", e));',
                          '        // Theme selection is restored by the isolated addon manager.')
    return source


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.write_text(patch_runtime(args.source.read_bytes()), encoding="utf-8")
