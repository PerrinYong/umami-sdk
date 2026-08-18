#!/usr/bin/env python3
"""Validate release versions and npm publishing metadata without dependencies."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
PACKAGE_NAME = "@perrin-yong/umami-sdk"
REPOSITORY_URL = "git+https://github.com/PerrinYong/umami-sdk.git"


def require_match(pattern: str, contents: str, source: str) -> str:
    match = re.search(pattern, contents, re.MULTILINE)
    if match is None:
        raise AssertionError(f"Version was not found in {source}")
    return match.group(1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--tag",
        help="release tag to verify; it must equal v<VERSION>",
    )
    args = parser.parse_args()

    canonical = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not SEMVER.fullmatch(canonical):
        raise AssertionError(f"VERSION is not valid SemVer: {canonical!r}")

    package = json.loads((ROOT / "typescript/package.json").read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "typescript/package-lock.json").read_text(encoding="utf-8"))
    python_project = (ROOT / "python/pyproject.toml").read_text(encoding="utf-8")
    dotnet_project = ElementTree.parse(
        ROOT / "dotnet/Pystone.Analytics/Pystone.Analytics.csproj"
    )

    versions = {
        "VERSION": canonical,
        "typescript/package.json": package["version"],
        "typescript/package-lock.json": lock["version"],
        "typescript/package-lock.json packages['']": lock["packages"][""]["version"],
        "python/pyproject.toml": require_match(
            r'^version\s*=\s*"([^"]+)"$', python_project, "python/pyproject.toml"
        ),
        "dotnet/Pystone.Analytics.csproj": dotnet_project.findtext(".//Version") or "",
        "typescript runtime default": require_match(
            r"sdkVersion\s*\?\?\s*'([^']+)'",
            (ROOT / "typescript/src/core/policy.ts").read_text(encoding="utf-8"),
            "typescript/src/core/policy.ts",
        ),
        ".NET runtime default": require_match(
            r'SdkVersion\s*\{[^\n]+\}\s*=\s*"([^"]+)"',
            (ROOT / "dotnet/Pystone.Analytics/Abstractions.cs").read_text(encoding="utf-8"),
            "dotnet/Pystone.Analytics/Abstractions.cs",
        ),
        "Python runtime default": require_match(
            r'^\s*sdk_version:\s*str\s*=\s*"([^"]+)"',
            (ROOT / "python/src/pystone_analytics/models.py").read_text(encoding="utf-8"),
            "python/src/pystone_analytics/models.py",
        ),
    }
    mismatches = {source: version for source, version in versions.items() if version != canonical}
    if mismatches:
        raise AssertionError(f"Version mismatch; expected {canonical}: {mismatches}")

    if package["name"] != PACKAGE_NAME:
        raise AssertionError(f"npm package name must be {PACKAGE_NAME}")
    if package.get("private") is True:
        raise AssertionError("npm package must not be marked private")
    publish = package.get("publishConfig", {})
    expected_publish = {
        "access": "public",
        "provenance": True,
        "registry": "https://registry.npmjs.org/",
    }
    if publish != expected_publish:
        raise AssertionError(f"Unexpected publishConfig: {publish!r}")
    if package.get("repository", {}).get("url") != REPOSITORY_URL:
        raise AssertionError("package repository URL does not match the GitHub repository")

    if args.tag and args.tag != f"v{canonical}":
        raise AssertionError(
            f"Release tag {args.tag!r} does not match package version v{canonical}"
        )

    print(f"Validated release metadata for {PACKAGE_NAME}@{canonical}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
