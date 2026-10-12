#!/usr/bin/env python3
"""Collect, verify and describe the Android candidate artifacts.

A candidate is an APK that has been built once and then *moved around* - uploaded as
a CI artifact, downloaded again, published. Every hop is a chance for the bytes to
change, and a release page that says a file is the verified build while it is a
re-upload is a lie nobody can see. So the candidate is pinned by digest at the moment
it is collected and the pin travels with it:

  collect   - validate the freshly built APKs and write candidate-manifest.json beside
              them. From here on, the manifest is the definition of what was built;
  restore   - check the bytes that arrived against that manifest before anything uses
              them. A mismatch is a refusal, never a warning;
  evidence  - write the acceptance record that goes on the release, describing the
              bytes that were accepted and the evidence they were accepted against.
              It never claims to have built anything: if the build-time record is not
              part of the candidate, that absence is what it records. The accepted
              artifacts are listed at the record's top level, which is where the build
              driver and the packaging step both read them from.

  python3 scripts/candidate_artifacts.py collect release/candidate
  python3 scripts/candidate_artifacts.py restore release/candidate
  ACCEPTANCE_URL=… python3 scripts/candidate_artifacts.py evidence release/acceptance.json
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_NAME = "candidate-manifest.json"
DEFAULT_MODULES = ("manager", "loader")


def load_build_module():
    """The build driver, loaded by path so this works from any working directory."""
    spec = importlib.util.spec_from_file_location(
        "build_android", str(ROOT / "scripts" / "build_android.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def git_commit() -> str:
    import subprocess

    try:
        done = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(ROOT), capture_output=True, text=True, timeout=60
        )
    except (OSError, subprocess.SubprocessError) as error:
        return f"unknown ({error})"
    return (done.stdout or "").strip() or "unknown"


def candidate_files(directory: Path, modules) -> dict:
    """The APK for each expected module, by module name."""
    found = {}
    for module in modules:
        exact = directory / f"{module}-release.apk"
        if exact.is_file():
            found[module] = exact
            continue
        loose = sorted(directory.glob(f"{module}*.apk"))
        if len(loose) == 1:
            found[module] = loose[0]
    return found


def problems_for(path: Path, build) -> list:
    problems = build.apk_problems(path)
    if path.name.startswith("loader"):
        try:
            build.verify_loader_assets(path)
        except build.BuildError as error:
            problems.append(str(error))
    return problems


def run_collect(args) -> int:
    directory = Path(args.directory)
    if not directory.is_absolute():
        directory = ROOT / directory
    modules = [name.strip() for name in args.modules.split(",") if name.strip()]
    if not directory.is_dir():
        print(f"FAIL no candidate directory at {directory}")
        return 1
    build = load_build_module()
    found = candidate_files(directory, modules)
    missing = [module for module in modules if module not in found]
    if missing and not args.allow_partial:
        print("FAIL the candidate is incomplete: no APK for " + ", ".join(missing))
        print("     a partial candidate cannot be published, so nothing was collected")
        return 1

    entries = []
    failed = False
    for module, path in sorted(found.items()):
        problems = problems_for(path, build)
        if problems:
            failed = True
            print(f"FAIL {module}: " + "; ".join(problems))
            continue
        entries.append(
            {
                "module": module,
                "file": path.name,
                "bytes": path.stat().st_size,
                "sha256": sha256_of(path),
                "verified": now(),
            }
        )
        print(f"ok   {module}: {path.name} {path.stat().st_size} bytes")
    if failed:
        print("FAIL a candidate that does not verify its own structure was not collected")
        return 1

    manifest = {
        "schema": 1,
        "project": "hypercord-android",
        "collected_at": now(),
        "commit": git_commit(),
        "modules": modules,
        "complete": not missing,
        "artifacts": entries,
    }
    target = directory / MANIFEST_NAME
    target.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\ncollected {len(entries)} artifact(s); the digest pin is {target}")
    return 0


def read_manifest(directory: Path):
    target = directory / MANIFEST_NAME
    if not target.is_file():
        return None
    try:
        return json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"FAIL {target} is not readable JSON: {error}")
        return None


def run_restore(args) -> int:
    directory = Path(args.directory)
    if not directory.is_absolute():
        directory = ROOT / directory
    manifest = read_manifest(directory)
    if manifest is None:
        print(
            "FAIL no candidate-manifest.json beside the artifacts: without the digest "
            "pin there is nothing to check these bytes against, and an unverifiable "
            "candidate is not accepted"
        )
        return 1
    build = load_build_module()
    failures = []
    for entry in manifest.get("artifacts", []):
        path = directory / str(entry.get("file") or "")
        if not path.is_file():
            failures.append(f"{entry.get('module')}: {path.name} did not arrive")
            continue
        digest = sha256_of(path)
        if digest != entry.get("sha256"):
            failures.append(
                f"{entry.get('module')}: {path.name} is not the accepted build "
                f"(expected {entry.get('sha256')}, got {digest})"
            )
            continue
        problems = problems_for(path, build)
        if problems:
            failures.append(f"{entry.get('module')}: " + "; ".join(problems))
            continue
        print(f"ok   {entry.get('module')}: {path.name} matches the accepted digest")
    expected = [module for module in manifest.get("modules", DEFAULT_MODULES)]
    present = {entry.get("module") for entry in manifest.get("artifacts", [])}
    for module in expected:
        if module not in present:
            failures.append(f"the manifest expects {module} and it is not in this candidate")
    if failures:
        for line in failures:
            print("FAIL " + line)
        print("\nrefusing to use a candidate that is not the accepted one")
        return 1
    print(f"\nrestored {len(manifest.get('artifacts', []))} accepted artifact(s)")
    return 0


def run_evidence(args) -> int:
    output = Path(args.output)
    if not output.is_absolute():
        output = ROOT / args.output
    directory = Path(args.candidate_dir)
    if not directory.is_absolute():
        directory = ROOT / args.candidate_dir
    acceptance_url = (args.acceptance_url or os.environ.get("ACCEPTANCE_URL", "")).strip()
    manifest = read_manifest(directory)

    record = {
        "schema": 1,
        "project": "hypercord-android",
        "generated_at": now(),
        "commit": git_commit(),
        "accepted_from": acceptance_url or "not provided",
        # The artifacts this record accepts, in the shape the build driver writes
        # (see build_android.py) and the shape the packaging step reads: the evidence
        # path replaces the build's own record, so if it did not list the artifacts
        # at the top level there would be nothing for `pack_release_artifacts.py` to
        # publish. The `candidate` block below is where they came from, not instead
        # of them.
        "artifacts": [],
        "candidate": {
            "directory": str(directory.relative_to(ROOT)).replace(os.sep, "/")
            if directory.is_relative_to(ROOT)
            else str(directory),
            "manifest": MANIFEST_NAME if manifest else "missing",
            "collected_at": (manifest or {}).get("collected_at", ""),
            "commit": (manifest or {}).get("commit", "unknown"),
            "artifacts": [],
        },
        "checks": [],
        "checks_not_run": [],
        "ok": False,
    }

    if manifest is None:
        print("FAIL no candidate-manifest.json: there is no accepted build to describe")
        return 1

    build = load_build_module()
    failures = []
    for entry in manifest.get("artifacts", []):
        path = directory / str(entry.get("file") or "")
        problem = None
        if not path.is_file():
            problem = "did not arrive"
        else:
            problems = problems_for(path, build)
            if problems:
                problem = "; ".join(problems)
        accepted = {
            "module": entry.get("module"),
            "file": entry.get("file"),
            "bytes": entry.get("bytes"),
            "sha256": entry.get("sha256"),
            "verified": problem is None,
        }
        # One list of accepted artifacts, reachable from both keys: a consumer that
        # reads the record at its top level and one that reads the candidate block
        # describe the same bytes.
        record["artifacts"].append(accepted)
        record["candidate"]["artifacts"].append(accepted)
        if problem:
            failures.append(f"{entry.get('module')}: {problem}")

    record["checks"].append(
        {
            "check": "the accepted candidate is present and its structure verifies",
            "ok": not failures,
            "detail": "; ".join(failures),
        }
    )
    if not acceptance_url:
        record["checks_not_run"].append(
            {
                "check": "the acceptance record was compared with the published evidence",
                "why": "ACCEPTANCE_URL was not set, so no external evidence was named; the "
                "candidate's own digest pin is all this record can stand on",
            }
        )
    else:
        record["checks"].append(
            {
                "check": "the acceptance evidence this record was accepted against",
                "ok": True,
                "detail": acceptance_url,
            }
        )

    if failures:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        print("FAIL the candidate does not verify; nothing is described as accepted")
        return 1

    # What was *not* checked here is as important as what was: this path does not build,
    # so it must not imply the build-time checks ran again.
    record["checks_not_run"].append(
        {
            "check": "the build-time checks (toolchain, signing, loader bundle) were re-run",
            "why": "this path does not build anything; it verifies the bytes that were built "
            "and accepted, and the build's own record is the one produced at build time",
        }
    )
    record["ok"] = all(item.get("ok") for item in record["checks"])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(f"wrote the acceptance record for the accepted candidate: {output}")
    return 0 if record["ok"] else 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Collect, verify and describe the Android candidate.")
    commands = parser.add_subparsers(dest="command", required=True)

    collect = commands.add_parser("collect", help="validate the built APKs and pin their digests")
    collect.add_argument("directory", help="the candidate directory, e.g. release/candidate")
    collect.add_argument("--modules", default=",".join(DEFAULT_MODULES))
    collect.add_argument(
        "--allow-partial",
        action="store_true",
        help="collect a candidate that is missing a module (it cannot be published)",
    )
    collect.set_defaults(handler=run_collect)

    restore = commands.add_parser("restore", help="check downloaded bytes against the digest pin")
    restore.add_argument("directory")
    restore.set_defaults(handler=run_restore)

    evidence = commands.add_parser("evidence", help="write the acceptance record for a candidate")
    evidence.add_argument("output", help="where the record is written, e.g. release/acceptance.json")
    evidence.add_argument("--candidate-dir", default="release/candidate")
    evidence.add_argument("--acceptance-url", default="")
    evidence.set_defaults(handler=run_evidence)

    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
