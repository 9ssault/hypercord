#!/usr/bin/env python3
"""Pack the accepted Android candidate into the release zip.

The order is the point. Publishing is one command in the workflow, so the last thing
before it must be the thing that refuses:

  * no acceptance record means no pack: a release whose evidence is missing is a
    release nobody can review;
  * a record that lists a failed check means no pack. This is the whole reason the
    record has an `ok` field per check rather than a summary sentence - a summary can
    be written by whoever is in a hurry;
  * the two APKs must be in the candidate directory *and* match their pinned digests,
    because packing a file that changed after it was verified publishes something the
    record does not describe.

The zip holds the two APKs under the names the release page publishes, the acceptance
record, and a SHA256SUMS for its own contents, so the archive can be checked without
the release page. The workflow writes the outer SHA256SUMS over the artifacts.

  python3 scripts/pack_release_artifacts.py --output-dir release --acceptance release/acceptance.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLISHED_NAMES = {"manager": "Hypercord-Manager.apk", "loader": "Hypercord-Loader.apk"}


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def project_version() -> str:
    """The version the artifact is named after, from the one place that owns it."""
    try:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "unknown"
    return str(package.get("version") or "unknown").strip() or "unknown"


def acceptance_failures(record) -> list:
    """Why this record is not one to publish from, as text."""
    problems = []
    if not isinstance(record, dict):
        return ["the acceptance record is not a JSON object"]
    if not record.get("artifacts"):
        problems.append("the record lists no artifacts")
    failed = [item for item in record.get("checks", []) if not item.get("ok")]
    for item in failed:
        problems.append(f"failed check: {item.get('check')}" + (
            f" ({item.get('detail')})" if item.get("detail") else ""
        ))
    if record.get("ok") is not True:
        problems.append("the record does not report a passing build")
    if not record.get("commit"):
        problems.append("the record names no source commit")
    return problems


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Pack the accepted Android candidate.")
    parser.add_argument("--output-dir", default="release")
    parser.add_argument("--acceptance", default="release/acceptance.json")
    parser.add_argument("--candidate-dir", default="", help="defaults to <output-dir>/candidate")
    parser.add_argument("--name", default="", help="override the zip name")
    args = parser.parse_args(argv)

    output = Path(args.output_dir)
    if not output.is_absolute():
        output = ROOT / args.output_dir
    acceptance = Path(args.acceptance)
    if not acceptance.is_absolute():
        acceptance = ROOT / args.acceptance
    candidate = Path(args.candidate_dir) if args.candidate_dir else output / "candidate"
    if not candidate.is_absolute():
        candidate = ROOT / candidate

    if not acceptance.is_file():
        print(f"FAIL no acceptance record at {acceptance}")
        print("     pack: nothing is packed without the record of what was checked")
        return 1
    try:
        record = json.loads(acceptance.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"FAIL the acceptance record is not readable JSON: {error}")
        return 1

    problems = acceptance_failures(record)
    if problems:
        for line in problems:
            print("FAIL " + line)
        print("     pack: a build that did not pass every check is not packaged")
        return 1

    manifest_path = candidate / "candidate-manifest.json"
    manifest = None
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            manifest = None
    pinned = {
        entry.get("module"): entry.get("sha256")
        for entry in (manifest or {}).get("artifacts", [])
        if isinstance(entry, dict)
    }

    contents = []
    for artifact in record.get("artifacts", []):
        module = str(artifact.get("module") or "")
        published = PUBLISHED_NAMES.get(module, f"Hypercord-{module}.apk")
        path = candidate / str(artifact.get("file") or "")
        if not path.is_file():
            print(f"FAIL the candidate APK for {module} is not in {candidate}")
            return 1
        digest = sha256_of(path)
        if pinned.get(module) and pinned[module] != digest:
            print(
                f"FAIL {path.name} changed after it was verified "
                f"(pinned {pinned[module]}, now {digest})"
            )
            return 1
        if artifact.get("sha256") and artifact["sha256"] != digest:
            print(
                f"FAIL {path.name} does not match the digest in the acceptance record "
                f"({artifact['sha256']} recorded, {digest} on disk)"
            )
            return 1
        contents.append((published, path, digest))
        print(f"ok   {module}: {published} ({path.stat().st_size} bytes)")

    output.mkdir(parents=True, exist_ok=True)
    name = args.name or f"Hypercord-{project_version()}-android.zip"
    target = output / name
    sums = []
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for published, path, digest in contents:
            archive.write(path, published)
            sums.append(f"{digest}  {published}")
        archive.write(acceptance, "acceptance.json")
        sums.append(f"{sha256_of(acceptance)}  acceptance.json")
        archive.writestr("SHA256SUMS", "\n".join(sums) + "\n")
    print(f"\npacked {len(contents)} APK(s) and the acceptance record into {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
