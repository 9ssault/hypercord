#!/usr/bin/env python3
"""Stage the pinned Android inputs this tree does not carry.

The loader and the manager are built from upstream artifacts that are deliberately not in
Git: the LSPatch release JAR (the patcher and its injection runtime), the Xposed API jar
(the loader compiles against it, the injected process provides it) and the Revenge runtime
bundle the loader patches into `assets/assault-runtime.js`. Each one is named with a URL and
a SHA-256 in `scripts/android-dependencies.json`, and nothing is written whose digest does
not match - an unpinned upstream is how a changed runtime ships unreviewed, and the whole
point of the pin file is that this step is checkable.

    python3 scripts/fetch_android_deps.py          # download what is missing
    python3 scripts/fetch_android_deps.py --check  # verify what is here, download nothing
    python3 scripts/fetch_android_deps.py --force  # re-download everything

An entry with no `url` is either checked in (a source file, the generated addons bundle) or
resolved by Gradle (nothing today), so it is reported and skipped rather than fetched.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PINS = ROOT / "scripts" / "android-dependencies.json"

# The loader's runtimeAssets task patches exactly this path, so a tree whose pin file does
# not name it cannot patch a runtime at all - that is a mistake in the pin file, not a
# missing download, and it is reported as such before anything is fetched.
RUNTIME = "android/loader/src/main/assets/revenge.js"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_pins() -> list:
    try:
        data = json.loads(PINS.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"FAIL {PINS.relative_to(ROOT)} is not in the tree, so there is nothing to pin")
        raise SystemExit(1)
    except ValueError as error:
        print(f"FAIL {PINS.relative_to(ROOT)} is not valid JSON: {error}")
        raise SystemExit(1)
    return data if isinstance(data, list) else []


def fetch(url: str, destination: Path) -> None:
    # HTTPS only, and a redirect that lands somewhere else has to be HTTPS too: a pin file
    # that could be satisfied over plain HTTP would make the digest the only thing standing
    # between the build and a rewritten download.
    if not url.lower().startswith("https://"):
        raise RuntimeError(f"refusing to download over anything but HTTPS: {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "hypercord-build"})
    with urllib.request.urlopen(request, timeout=120) as response:
        final = response.geturl()
        if not final.lower().startswith("https://"):
            raise RuntimeError(f"the download redirected to {final}, which is not HTTPS")
        payload = response.read()
    pending = destination.with_name(destination.name + ".download")
    pending.write_bytes(payload)
    os.replace(pending, destination)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="verify, download nothing")
    parser.add_argument("--force", action="store_true", help="re-download even if present")
    args = parser.parse_args()

    pins = read_pins()
    if not pins:
        print("FAIL the pin file lists no inputs")
        return 1
    if not any(str(entry.get("path", "")).endswith("revenge.js") for entry in pins):
        print(f"FAIL no pin names {RUNTIME}, which is the file the loader's runtimeAssets")
        print("     task patches; the tree cannot build a runtime without it")
        return 1

    failures = 0
    fetched = 0
    for entry in pins:
        if not isinstance(entry, dict):
            continue
        rel = str(entry.get("path") or "")
        if not rel:
            continue
        target = ROOT / rel
        url = str(entry.get("url") or "")
        digest = entry.get("sha256")
        source = str(entry.get("source") or "unknown")
        if not url:
            # Checked in, or produced by a build step: reported so the list stays complete.
            state = "present" if target.is_file() else "not in the tree (generated or checked in)"
            print(f"skip {rel}  ({source}): {state}")
            continue
        if not digest:
            print(f"FAIL {rel} names a URL but no SHA-256, so nothing could be verified")
            failures += 1
            continue

        if target.is_file() and not args.force:
            actual = sha256_of(target)
            if actual == digest:
                print(f"ok   {rel}  ({source})")
                continue
            if args.check:
                print(f"FAIL {rel} does not match its pin")
                print(f"       expected {digest}")
                print(f"       found    {actual}")
                failures += 1
                continue
            print(f"note {rel} does not match its pin; re-fetching from {url}")
        elif args.check:
            print(f"FAIL {rel} is not staged ({source})")
            failures += 1
            continue

        if args.check:
            print(f"note {rel} would be fetched from {url}")
            continue

        target.parent.mkdir(parents=True, exist_ok=True)
        print(f"get  {rel}  ({source})")
        try:
            fetch(url, target)
        except (urllib.error.URLError, OSError, RuntimeError) as error:
            print(f"FAIL {rel} could not be downloaded: {error}")
            failures += 1
            continue
        actual = sha256_of(target)
        if actual != digest:
            target.unlink(missing_ok=True)
            print(f"FAIL {rel} did not match its pin and was deleted")
            print(f"       expected {digest}")
            print(f"       found    {actual}")
            failures += 1
            continue
        print(f"ok   {rel}  ({target.stat().st_size} bytes, digest verified)")
        fetched += 1

    print()
    if failures:
        print(f"FAIL {failures} input(s) are not the pinned ones; nothing was left that could not be verified")
        return 1
    print(f"every pinned input is staged and verified ({fetched} fetched this run)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
