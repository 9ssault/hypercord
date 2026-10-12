#!/usr/bin/env python3
"""Build the Android half of Hypercord, and say what it actually built.

The desktop half is packaged by electron-builder, which refuses a stale or
half-written tree. This is the same idea for the phone client, which electron-builder
knows nothing about:

  * Gradle is driven here rather than by hand, one call per variant, because the
    release path in `.github/workflows/android-release.yml` has to be the same one a
    person runs on their own machine - two build paths means the artifact nobody
    tested is the one that ships;
  * every output is checked before it is accepted: the APK exists, is not empty,
    parses as a zip, carries an AndroidManifest.xml, and - for the loader - carries
    the documented asset bundle and nothing else. A Gradle exit code of 0 with no
    APK on disk is the failure this exists to catch, and it is caught by looking at
    the disk, not by trusting the exit code;
  * the signing keystore arrives through the environment
    (`HYPERCORD_KEYSTORE_PATH`, `HYPERCORD_SIGNING_PASSWORD`, optional
    `HYPERCORD_SIGNING_ALIAS`/`HYPERCORD_KEYSTORE_TYPE`) and is handed to Gradle as
    the standard injected-signing properties. The password is never printed and is
    redacted out of every command line this script logs - a build log is a file that
    gets pasted into issues;
  * the run ends in `release/acceptance.json`, the record the packaging scripts and
    the CI workflow read. It lists the checks that ran, and it lists the ones that
    could not run and why, because a record that only ever says "passed" is worth
    nothing to the person deciding whether to publish.

Nothing here fabricates a build. A tree without Gradle, without a JDK or without the
pinned dependencies fails with the missing input named - see
`scripts/android-dependencies.json` and the known gap in `docs/ANDROID-README.md`.

Importing this module has no side effects: `tests/loader-assets.test.mjs` imports it
to check the loader asset rules on its own, so nothing may run at import time and no
environment variable may be required to load it.

  python3 scripts/build_android.py                  # the manager, release variant
  python3 scripts/build_android.py --all-variants   # manager and loader
  python3 scripts/build_android.py --variant debug  # a debug build, unsigned
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ANDROID_DIR = ROOT / "android"
DEFAULT_OUTPUT = ROOT / "release" / "candidate"
ACCEPTANCE = ROOT / "release" / "acceptance.json"
DEPENDENCIES = ROOT / "scripts" / "android-dependencies.json"

# The two modules this repository builds, and the APK each one has to produce.
MODULES = ("manager", "loader")

# ---------------------------------------------------------------------------
# the loader's published asset bundle
# ---------------------------------------------------------------------------
#
# The loader injects these into the client it patches, so the bundle is a contract
# with the JavaScript half in `core/`: dropping one of them produces an APK that
# installs and then quietly does nothing. The list is exactly what ships - an extra
# entry is refused as well as a missing one, because a second copy of the runtime
# (an old `revenge.js` left behind by a build) would be shipped twice without anyone
# noticing. `xposed_init` is the file the Xposed runtime reads to find the entry
# point, so a wrong class name there is an APK that loads nothing at all.
LOADER_ENTRYPOINT = "app.assault.loader.AssaultLoader"
MAX_ASSET_BYTES = 16 * 1024 * 1024  # 16 MiB: the runtime bundle, not a media file
ASSET_PREFIX = "assets/"
REQUIRED_LOADER_ASSETS = (
    "addons.js",
    "assault.js",
    "account-controls.js",
    "rich-presence.js",
    "history-export.js",
    "html-export.js",
    "assault-runtime.js",
    "xposed_init",
    "licenses/Acorn-MIT.txt",
    "licenses/Revenge-BSD-3-Clause.txt",
)


class BuildError(RuntimeError):
    """A failure a person can act on, with the missing input named."""


def _read_entries(apk_path: Path) -> dict:
    """Every file in the APK under assets/, by name, with its bytes read once."""
    try:
        with zipfile.ZipFile(apk_path) as archive:
            names = [info for info in archive.infolist() if not info.is_dir()]
            assets = {}
            for info in names:
                if not info.filename.startswith(ASSET_PREFIX):
                    continue
                name = info.filename[len(ASSET_PREFIX):]
                if not name:
                    continue
                assets[name] = archive.read(info.filename)
    except zipfile.BadZipFile as error:
        raise BuildError(f"{apk_path} is not a zip/APK: {error}") from error
    except OSError as error:
        raise BuildError(f"could not read {apk_path}: {error}") from error
    return assets


def loader_asset_problems(apk_path) -> list:
    """Every problem with the loader's asset bundle, as text - never just the first.

    Returning the whole list is deliberate: fixing one asset, re-running, and finding
    the next one is how a build wastes an afternoon.
    """
    path = Path(apk_path)
    if not path.is_file():
        raise BuildError(f"the loader APK is not on disk: {path}")
    if path.stat().st_size == 0:
        raise BuildError(f"the loader APK is empty: {path}")
    assets = _read_entries(path)
    problems = []
    for name in REQUIRED_LOADER_ASSETS:
        if name not in assets:
            problems.append(f"missing asset: {name}")
            continue
        data = assets[name]
        if not data:
            problems.append(f"empty asset: {name}")
        if len(data) > MAX_ASSET_BYTES:
            problems.append(
                f"{name} is {len(data)} bytes; the loader bundle limit is "
                f"{MAX_ASSET_BYTES} bytes ({MAX_ASSET_BYTES // (1024 * 1024)} MiB)"
            )
    for name in sorted(assets):
        if name not in REQUIRED_LOADER_ASSETS:
            problems.append(
                f"unexpected asset: {name} (only the documented bundle is published; "
                "a second runtime or a stale build output would ship alongside it)"
            )
    entrypoint = assets.get("xposed_init")
    if entrypoint is not None:
        named = entrypoint.decode("utf-8", "replace").strip()
        if named != LOADER_ENTRYPOINT:
            problems.append(
                f'xposed_init names "{named}" where it must name "{LOADER_ENTRYPOINT}"'
            )
    return problems


def verify_loader_assets(apk_path) -> bool:
    """Refuse a loader APK whose asset bundle is not the documented one.

    This is the rule `tests/loader-assets.test.mjs` pins down by building the seven
    broken bundles it must refuse; it raises rather than returning False so that a
    caller cannot forget to look at the answer.
    """
    problems = loader_asset_problems(apk_path)
    if problems:
        raise BuildError(
            "the loader asset bundle is not publishable:\n  - " + "\n  - ".join(problems)
        )
    return True


# ---------------------------------------------------------------------------
# the general checks every APK has to survive
# ---------------------------------------------------------------------------


def apk_problems(apk_path) -> list:
    """The checks that apply to any APK, not only the loader."""
    path = Path(apk_path)
    if not path.is_file():
        return [f"the APK is not on disk: {path}"]
    if path.stat().st_size == 0:
        return [f"the APK is empty: {path}"]
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
    except zipfile.BadZipFile as error:
        return [f"the APK is not a zip: {error}"]
    problems = []
    if "AndroidManifest.xml" not in names:
        problems.append("the APK carries no AndroidManifest.xml")
    if not any(name.startswith("classes") and name.endswith(".dex") for name in names):
        problems.append("the APK carries no classes.dex")
    return problems


def sha256_of(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# toolchain and dependencies
# ---------------------------------------------------------------------------


def _capture(command, **kwargs) -> str:
    try:
        done = subprocess.run(
            command, capture_output=True, text=True, timeout=120, **kwargs
        )
    except (OSError, subprocess.SubprocessError) as error:
        return f"unavailable ({error})"
    if done.returncode != 0:
        first = (done.stderr or done.stdout or "").strip().splitlines()
        return f"failed ({first[0] if first else 'exit ' + str(done.returncode)})"
    return (done.stdout or done.stderr or "").strip()


def tool_versions(gradle="gradle") -> dict:
    """What built this, recorded so a record can be reproduced or dismissed."""
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or ""
    return {
        "python": platform.python_version(),
        "java": _capture(["java", "-version"]),
        "gradle": _capture([gradle, "--version"]),
        "android_sdk": sdk or "ANDROID_HOME/ANDROID_SDK_ROOT are not set",
        "host": platform.platform(),
    }


def read_dependencies() -> list:
    """The pinned inputs, or an empty list when the pin file is absent.

    An absent pin file is not fatal by itself, but it is recorded: the loader test
    and `scripts/patch_runtime.py` both read this file, and patching a runtime whose
    checksum was never pinned is how an upstream change ships unreviewed.
    """
    try:
        data = json.loads(DEPENDENCIES.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def dependency_gaps(entries) -> list:
    """The pinned inputs that are not present on this machine, named as gaps."""
    gaps = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path") or "")
        required = bool(entry.get("required", True))
        if not required or not path:
            continue
        resolved = Path(path)
        if not resolved.is_absolute():
            resolved = ROOT / path
        if not resolved.exists():
            gaps.append(
                {
                    "path": path,
                    "source": str(entry.get("source") or "unknown"),
                    "reason": "not present in this tree",
                }
            )
        elif not entry.get("sha256"):
            gaps.append(
                {
                    "path": path,
                    "source": str(entry.get("source") or "unknown"),
                    "reason": "present but not checksum-pinned",
                }
            )
    return gaps


# ---------------------------------------------------------------------------
# driving Gradle
# ---------------------------------------------------------------------------


def gradle_command(module: str, variant: str, keystore: dict = None) -> list:
    """The Gradle invocation for one module variant.

    The keystore is passed as the injected-signing properties rather than baked into
    a `build.gradle`, so no signing material is ever a tracked file.
    """
    task = f":{module}:assemble{variant.capitalize()}"
    command = ["gradle", "--project-dir", str(ANDROID_DIR), "--console=plain", task]
    if keystore:
        command += [
            f"-Pandroid.injected.signing.store.file={keystore['store_file']}",
            f"-Pandroid.injected.signing.store.password={keystore['store_password']}",
            f"-Pandroid.injected.signing.key.alias={keystore['key_alias']}",
            f"-Pandroid.injected.signing.key.password={keystore['key_password']}",
        ]
    return command


def redacted(command: list) -> str:
    """The command as it may be logged: every password replaced, never shortened."""
    safe = []
    for part in command:
        if ".password=" in part:
            safe.append(part.split("=", 1)[0] + "=***")
        else:
            safe.append(part)
    return " ".join(safe)


def signing_from_environment() -> dict:
    """The keystore to sign with, or an empty dict when none was provided.

    Both parts are required together: a password with no keystore and a keystore with
    no password are both a signing configuration somebody forgot, and a build that
    silently produced an unsigned APK from half a configuration is how an unsigned
    release gets published.
    """
    store_file = os.environ.get("HYPERCORD_KEYSTORE_PATH", "").strip()
    store_password = os.environ.get("HYPERCORD_SIGNING_PASSWORD", "")
    if not store_file and not store_password:
        return {}
    if not store_file or not store_password:
        raise BuildError(
            "signing needs both HYPERCORD_KEYSTORE_PATH and HYPERCORD_SIGNING_PASSWORD; "
            "only one was set, so nothing was signed"
        )
    keystore = Path(store_file)
    if not keystore.is_file():
        raise BuildError(f"the keystore named by HYPERCORD_KEYSTORE_PATH is not a file: {keystore}")
    alias = os.environ.get("HYPERCORD_SIGNING_ALIAS", "hypercord").strip() or "hypercord"
    return {
        "store_file": str(keystore),
        "store_password": store_password,
        "key_alias": alias,
        "key_password": store_password,
        "type": os.environ.get("HYPERCORD_KEYSTORE_TYPE", "PKCS12").strip() or "PKCS12",
    }


def find_built_apk(module: str, variant: str) -> Path:
    """Where Gradle should have put the APK, whatever the module is called."""
    outputs = ANDROID_DIR / module / "build" / "outputs" / "apk" / variant
    expected = outputs / f"{module}-{variant}.apk"
    if expected.is_file():
        return expected
    # a module with an applicationId of its own names the file after that instead of
    # the directory, so fall back to the only APK in the variant's output directory
    candidates = sorted(outputs.glob("*.apk")) if outputs.is_dir() else []
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise BuildError(
            f"Gradle reported success but wrote no APK for {module} ({variant}); "
            f"looked in {outputs.relative_to(ROOT)}"
        )
    raise BuildError(
        f"more than one APK in {outputs.relative_to(ROOT)} for {module} ({variant}): "
        + ", ".join(candidate.name for candidate in candidates)
    )


def preflight(modules, gradle="gradle") -> list:
    """Everything that makes the build impossible, before Gradle is even started."""
    blockers = []
    if not (ANDROID_DIR / "settings.gradle").is_file() and not (
        ANDROID_DIR / "settings.gradle.kts"
    ).is_file():
        blockers.append(
            "android/settings.gradle is missing, so there is no Gradle build to run "
            "(this is the gap docs/ANDROID-README.md records: the Java sources are here "
            "but the Gradle project is not)"
        )
    if shutil.which(gradle) is None:
        blockers.append(f"{gradle} is not on PATH")
    if shutil.which("java") is None:
        blockers.append("java is not on PATH (JDK 17 or newer is required)")
    for module in modules:
        if not (ANDROID_DIR / module / "build.gradle").is_file() and not (
            ANDROID_DIR / module / "build.gradle.kts"
        ).is_file():
            blockers.append(f"android/{module}/build.gradle is missing")
    if not os.environ.get("ANDROID_HOME") and not os.environ.get("ANDROID_SDK_ROOT"):
        blockers.append("ANDROID_HOME (or ANDROID_SDK_ROOT) is not set, so no SDK")
    return blockers


def build_variant(module: str, variant: str, output: Path, keystore: dict) -> dict:
    """Run Gradle for one module and accept the APK only after looking at it."""
    command = gradle_command(module, variant, keystore)
    print("# " + redacted(command))
    done = subprocess.run(command, cwd=str(ROOT))
    code = done.returncode
    apk = find_built_apk(module, variant) if code == 0 else None
    if code != 0:
        raise BuildError(
            f"gradle {module}:{variant} exited {code}; the APK was not produced and "
            "nothing below this line should be believed"
        )
    destination = output / f"{module}-{variant}.apk"
    shutil.copy2(apk, destination)
    problems = apk_problems(destination)
    if problems:
        raise BuildError(
            f"the APK Gradle produced for {module} is not usable:\n  - "
            + "\n  - ".join(problems)
        )
    record = {
        "module": module,
        "variant": variant,
        "file": str(destination.relative_to(ROOT)).replace(os.sep, "/"),
        "bytes": destination.stat().st_size,
        "sha256": sha256_of(destination),
        "signed": bool(keystore),
        "signing": (
            f"injected signing with alias {keystore['key_alias']} ({keystore['type']})"
            if keystore
            else "unsigned: no keystore was provided, so this APK cannot be published"
        ),
    }
    return record


# ---------------------------------------------------------------------------
# acceptance
# ---------------------------------------------------------------------------


def git_commit() -> str:
    return _capture(["git", "rev-parse", "HEAD"])


def write_acceptance(path: Path, record: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return path


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Build the Android client and write an acceptance record."
    )
    parser.add_argument(
        "--all-variants",
        action="store_true",
        help="build the release variant of every module (manager and loader)",
    )
    parser.add_argument(
        "--modules",
        default="",
        help="comma-separated modules to build (default: manager, or every module "
        "with --all-variants)",
    )
    parser.add_argument("--variant", default="release", choices=["release", "debug"])
    parser.add_argument(
        "--output-dir", default=str(DEFAULT_OUTPUT), help="where the candidate APKs go"
    )
    parser.add_argument("--gradle", default=os.environ.get("GRADLE_CMD", "gradle"))
    parser.add_argument(
        "--acceptance", default=str(ACCEPTANCE), help="where the record is written"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print the plan and run nothing"
    )
    args = parser.parse_args(argv)

    if args.modules:
        modules = [name.strip() for name in args.modules.split(",") if name.strip()]
    else:
        modules = list(MODULES) if args.all_variants else ["manager"]

    output = Path(args.output_dir)
    if not output.is_absolute():
        output = ROOT / args.output_dir
    acceptance_path = Path(args.acceptance)
    if not acceptance_path.is_absolute():
        acceptance_path = ROOT / args.acceptance

    started = datetime.now(timezone.utc)
    record = {
        "schema": 1,
        "project": "hypercord-android",
        "generated_at": started.isoformat().replace("+00:00", "Z"),
        "commit": git_commit(),
        "variant": args.variant,
        "modules": modules,
        "tools": tool_versions(args.gradle),
        "artifacts": [],
        "checks": [],
        "checks_not_run": [],
        "dependency_gaps": [],
        "ok": False,
    }

    if args.dry_run:
        print("# plan")
        for module in modules:
            print("  " + redacted(gradle_command(module, args.variant, {})))
        print(f"  the APKs would be written to {output}")
        return 0

    dependencies = read_dependencies()
    record["dependency_gaps"] = dependency_gaps(dependencies)
    if not dependencies:
        record["checks_not_run"].append(
            {
                "check": "pinned Android dependencies",
                "why": "scripts/android-dependencies.json is missing, so no input could be "
                "checked for presence or checksum",
            }
        )

    blockers = preflight(modules, args.gradle)
    if blockers:
        for blocker in blockers:
            print("FAIL " + blocker)
        record["checks"].append(
            {
                "check": "the toolchain and Gradle project are present",
                "ok": False,
                "detail": "; ".join(blockers),
            }
        )
        write_acceptance(acceptance_path, record)
        print(f"\nno APK was produced. The record of what was missing is in {acceptance_path}")
        return 1
    record["checks"].append(
        {"check": "the toolchain and Gradle project are present", "ok": True}
    )

    try:
        keystore = signing_from_environment()
    except BuildError as error:
        print("FAIL " + str(error))
        record["checks"].append(
            {"check": "signing configuration", "ok": False, "detail": str(error)}
        )
        write_acceptance(acceptance_path, record)
        return 1
    if not keystore:
        record["checks_not_run"].append(
            {
                "check": "the APKs are signed",
                "why": "no keystore was provided (HYPERCORD_KEYSTORE_PATH and "
                "HYPERCORD_SIGNING_PASSWORD were not both set), so these are debug-grade "
                "unsigned artifacts and must not be published",
            }
        )
    else:
        record["checks"].append(
            {"check": "a signing keystore was provided", "ok": True, "detail": keystore["type"]}
        )

    output.mkdir(parents=True, exist_ok=True)
    for module in modules:
        try:
            artifact = build_variant(module, args.variant, output, keystore)
        except BuildError as error:
            print("FAIL " + str(error))
            record["checks"].append(
                {"check": f"{module}: the APK is usable", "ok": False, "detail": str(error)}
            )
            write_acceptance(acceptance_path, record)
            print(f"\nno usable APK for {module}. Record: {acceptance_path}")
            return 1
        record["artifacts"].append(artifact)
        record["checks"].append(
            {
                "check": f"{module}: the APK exists, is not empty, is a zip and carries a manifest",
                "ok": True,
                "detail": f"{artifact['bytes']} bytes",
            }
        )
        if module == "loader":
            # The loader's asset bundle is what the patched client actually loads, so
            # it is verified here, on the artifact, rather than trusted from Gradle.
            try:
                verify_loader_assets(output / f"loader-{args.variant}.apk")
                record["checks"].append(
                    {"check": "loader: the asset bundle is the documented one", "ok": True}
                )
            except BuildError as error:
                print("FAIL " + str(error))
                record["checks"].append(
                    {
                        "check": "loader: the asset bundle is the documented one",
                        "ok": False,
                        "detail": str(error),
                    }
                )
                write_acceptance(acceptance_path, record)
                print(f"\nthe loader APK was built but is not publishable. Record: {acceptance_path}")
                return 1

    apksigner = shutil.which("apksigner")
    if apksigner and keystore:
        for artifact in record["artifacts"]:
            target = ROOT / artifact["file"]
            output_text = _capture([apksigner, "verify", "--print-certs", str(target)])
            ok = "Signer" in output_text or "verified" in output_text.lower()
            record["checks"].append(
                {
                    "check": f"{artifact['module']}: apksigner accepts the signature",
                    "ok": bool(ok),
                    "detail": output_text.splitlines()[0] if output_text else "",
                }
            )
            if not ok:
                write_acceptance(acceptance_path, record)
                print("FAIL apksigner did not accept the signature")
                return 1
    elif keystore:
        record["checks_not_run"].append(
            {"check": "apksigner verifies the signature", "why": "apksigner is not on PATH"}
        )

    record["ok"] = all(item.get("ok") for item in record["checks"]) and bool(record["artifacts"])
    write_acceptance(acceptance_path, record)
    print(f"\n# built {len(record['artifacts'])} artifact(s)")
    for artifact in record["artifacts"]:
        print(f"  {artifact['file']}  {artifact['bytes']} bytes  {artifact['signing']}")
    print(f"record: {acceptance_path}")
    if record["dependency_gaps"]:
        print("\n# inputs that are not in this tree (named, not guessed)")
        for gap in record["dependency_gaps"]:
            print(f"  {gap['path']}  ({gap['source']}): {gap['reason']}")
    return 0 if record["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
