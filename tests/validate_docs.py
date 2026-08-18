#!/usr/bin/env python3
"""Validate that the agent integration guide matches SDK and schema sources."""

from __future__ import annotations

import json
from pathlib import Path
import re
from urllib.parse import unquote
from xml.etree import ElementTree


SDK_ROOT = Path(__file__).resolve().parents[1]
GUIDE = SDK_ROOT / "docs/integration-guide.md"
TEMPLATE = SDK_ROOT / "docs/product-integration-template.md"
PRODUCT_GUIDE = SDK_ROOT / "docs/product-integration.md"
ARCHITECTURE = SDK_ROOT / "docs/architecture.md"
READINESS = SDK_ROOT / "docs/production-readiness.md"
ANALYTICS_SPEC = SDK_ROOT / "docs/analytics-spec.md"

registry = json.loads(
    (SDK_ROOT / "schema/event-registry.json").read_text(encoding="utf-8")
)
policy = json.loads(
    (SDK_ROOT / "schema/privacy-policy.json").read_text(encoding="utf-8")
)
typescript = json.loads(
    (SDK_ROOT / "typescript/package.json").read_text(encoding="utf-8")
)
python_project = (SDK_ROOT / "python/pyproject.toml").read_text(encoding="utf-8")
python_version_match = re.search(
    r'^version\s*=\s*"([^"]+)"$', python_project, re.MULTILINE
)
assert python_version_match is not None
dotnet = ElementTree.parse(
    SDK_ROOT / "dotnet/Pystone.Analytics/Pystone.Analytics.csproj"
)

versions = {
    typescript["version"],
    python_version_match.group(1),
    dotnet.findtext(".//Version"),
}
assert len(versions) == 1 and None not in versions, versions
sdk_version = versions.pop()

guide = GUIDE.read_text(encoding="utf-8")
assert f"当前 SDK 版本：`{sdk_version}`" in guide
assert f"事件 Schema 版本：`{registry['schema_version']}`" in guide
assert f"Privacy Policy 版本：`{policy['policy_version']}`" in guide

scope_labels = {
    "session": "Session",
    "installation": "Installation",
    "account": "Account",
}
row_pattern = re.compile(
    r"^\| `(?P<name>[a-z][a-z0-9_]*)` \| "
    r"(?P<scope>Session|Installation|Account) \| "
    r"(?P<required>.*?) \| (?P<optional>.*?) \|",
    re.MULTILINE,
)
rows = {
    match.group("name"): match.groupdict()
    for match in row_pattern.finditer(guide)
    if match.group("name") in registry["events"]
}
assert set(rows) == set(registry["events"]), (
    set(registry["events"]) - set(rows),
    set(rows) - set(registry["events"]),
)


def properties(cell: str) -> list[str]:
    if cell.strip() == "—":
        return []
    return re.findall(r"`([a-z][a-z0-9_]*)`", cell)


for name, definition in registry["events"].items():
    row = rows[name]
    assert row["scope"] == scope_labels[definition["identity_scope"]], name
    assert properties(row["required"]) == definition["required"], name
    assert properties(row["optional"]) == definition["optional"], name


def validate_local_links(path: Path) -> None:
    contents = path.read_text(encoding="utf-8")
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", contents):
        target = target.strip("<>").split("#", 1)[0]
        if not target or re.match(r"^[a-z]+://", target, re.IGNORECASE):
            continue
        resolved = (path.parent / unquote(target)).resolve()
        assert resolved.exists(), f"Broken local link in {path}: {target}"


for document in (
    GUIDE,
    TEMPLATE,
    PRODUCT_GUIDE,
    ARCHITECTURE,
    READINESS,
    ANALYTICS_SPEC,
    SDK_ROOT / "README.md",
):
    validate_local_links(document)

print(
    f"Validated SDK docs v{sdk_version}: "
    f"{len(rows)} events, policy v{policy['policy_version']}, and local links"
)
