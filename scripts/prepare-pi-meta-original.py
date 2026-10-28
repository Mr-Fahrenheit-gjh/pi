#!/usr/bin/env python3
"""Prepare Pi Meta's verified original SDK in an isolated Web candidate, not the live service."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile

VERSION = "1.4.0"
ARCHIVE_SHA512 = "Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg=="
ORIGINAL_FINGERPRINT = "8b2ae2b3da46f7a6e026e6753b4c9b48ac3c724b6e1444ae942ff7f5272aff6a"
LIVE = Path("/opt/homebrew/lib/node_modules/@agegr/pi-web")


def file_digest(path, algorithm="sha256"):
    digest = hashlib.new(algorithm)
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.digest()


def original_fingerprint(root):
    metadata = root / "package.json"
    if metadata.is_symlink() or not metadata.is_file():
        raise RuntimeError("Original SDK metadata is missing or linked")
    files = [metadata]
    dist = root / "dist"
    if dist.is_symlink() or not dist.is_dir():
        raise RuntimeError("Original SDK dist is missing or linked")
    for item in dist.rglob("*"):
        if item.is_symlink():
            raise RuntimeError("Original SDK contains a symlink")
        if item.is_file() and not item.name.endswith(".map"):
            files.append(item)
        elif not item.is_file() and not item.is_dir():
            raise RuntimeError("Original SDK contains an unsupported entry")
    digest = hashlib.sha256()
    for item in sorted(files, key=lambda path: path.relative_to(root).as_posix()):
        digest.update(item.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(file_digest(item))
    return digest.hexdigest()


def assert_cli_executable(root):
    for name in ("dist/cli.js", "dist/bundle/cli.js"):
        cli = root / name
        if cli.is_symlink() or not cli.is_file() or not os.access(cli, os.X_OK):
            raise RuntimeError("Original SDK CLI is missing or not executable")


def nested_fingerprint(root):
    if not root.exists():
        return None
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError("Nested SDK dependencies must be a real directory")
    root = root.resolve(strict=True)
    digest = hashlib.sha256()
    for item in sorted(root.rglob("*"), key=lambda path: path.relative_to(root).as_posix()):
        name = item.relative_to(root).as_posix().encode()
        if item.is_symlink():
            link = os.readlink(item)
            if os.path.isabs(link) or not item.resolve(strict=True).is_relative_to(root):
                raise RuntimeError("Nested SDK dependencies contain an unsafe symlink")
            value = b"L" + link.encode()
        elif item.is_dir():
            value = b"D"
        elif item.is_file():
            value = b"F" + file_digest(item)
        else:
            raise RuntimeError("Nested SDK dependencies contain an unsupported entry")
        digest.update(name + b"\0" + value + b"\0")
    return digest.hexdigest()


def extract_original(archive, destination):
    if base64.b64encode(file_digest(archive, "sha512")).decode() != ARCHIVE_SHA512:
        raise RuntimeError("Original SDK archive integrity mismatch")
    seen = set()
    total = 0
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            parts = member.name.split("/")
            if "\\" in member.name or any(part in {"", ".", ".."} for part in parts):
                raise RuntimeError("Unsafe SDK archive path")
            relative = PurePosixPath(member.name)
            if relative == PurePosixPath("package/package.json"):
                target = destination / "package.json"
            elif len(parts) >= 3 and parts[:2] == ["package", "dist"]:
                target = destination.joinpath(*parts[1:])
            else:
                continue
            if member.name in seen:
                raise RuntimeError("Duplicate SDK archive entry")
            seen.add(member.name)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                total += member.size
                if total > 100 * 1024 * 1024:
                    raise RuntimeError("SDK archive is too large")
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode & 0o755)
            else:
                raise RuntimeError("SDK archive contains a linked or special file")
    if original_fingerprint(destination) != ORIGINAL_FINGERPRINT:
        raise RuntimeError("Original SDK fingerprint mismatch")
    assert_cli_executable(destination)
    metadata = json.loads((destination / "package.json").read_text())
    if metadata.get("name") != "@earendil-works/pi-coding-agent" or metadata.get("version") != VERSION:
        raise RuntimeError("Original SDK identity mismatch")


def prepare(candidate, archive):
    candidate = Path(candidate).resolve(strict=True)
    live = LIVE.resolve(strict=False)
    if candidate == live or candidate.is_relative_to(live):
        raise RuntimeError("Refusing to change the live Web installation")
    modules = candidate / "node_modules"
    sdk = modules / "@earendil-works/pi-coding-agent"
    if modules.is_symlink() or not modules.is_dir() or sdk.is_symlink() or not sdk.is_dir():
        raise RuntimeError("Candidate and its SDK must be independent real directories")
    metadata = json.loads((sdk / "package.json").read_text())
    if metadata.get("name") != "@earendil-works/pi-coding-agent" or metadata.get("version") != VERSION:
        raise RuntimeError("Candidate SDK identity or version mismatch")
    archive = Path(archive).resolve(strict=True)
    if base64.b64encode(file_digest(archive, "sha512")).decode() != ARCHIVE_SHA512:
        raise RuntimeError("Original SDK archive integrity mismatch")
    nested = sdk / "node_modules"
    nested_hash = nested_fingerprint(nested)
    target = modules / ".pi-meta-original"
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_dir() or original_fingerprint(target) != ORIGINAL_FINGERPRINT:
            raise RuntimeError("Existing Pi Meta SDK is not the verified original")
        assert_cli_executable(target)
        if nested_fingerprint(target / "node_modules") != nested_hash:
            raise RuntimeError("Existing Pi Meta SDK dependencies do not match the candidate")
        return "already-present"
    with tempfile.TemporaryDirectory(prefix="pi-meta-original-", dir=modules) as temp:
        staging = Path(temp) / "original"
        staging.mkdir(mode=0o700)
        extract_original(archive, staging)
        if nested_hash is not None:
            shutil.copytree(nested, staging / "node_modules", symlinks=True)
            if nested_fingerprint(staging / "node_modules") != nested_hash:
                raise RuntimeError("Copied SDK dependencies do not match")
        # Exclusive directory creation prevents overwriting an existing SDK.
        target.mkdir(mode=0o700)
        try:
            for item in staging.iterdir():
                item.rename(target / item.name)
        except Exception:
            shutil.rmtree(target)
            raise
    return "created"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--archive", required=True)
    args = parser.parse_args()
    print(json.dumps({"status": prepare(args.candidate, args.archive), "version": VERSION}))


if __name__ == "__main__":
    main()
