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
CONFIGURATION = SDK_ROOT / "docs/configuration.md"
CICD = SDK_ROOT / "docs/cicd.md"

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
package_name = typescript["name"]

guide = GUIDE.read_text(encoding="utf-8")
configuration = CONFIGURATION.read_text(encoding="utf-8")
product_guide = PRODUCT_GUIDE.read_text(encoding="utf-8")
readme = (SDK_ROOT / "README.md").read_text(encoding="utf-8")
assert f"当前 SDK 版本：`{sdk_version}`" in guide
assert f"事件 Schema 版本：`{registry['schema_version']}`" in guide
assert f"Privacy Policy 版本：`{policy['policy_version']}`" in guide
assert package_name == "@perrin-yong/umami-sdk"
assert package_name in guide
assert package_name in product_guide
assert package_name in readme

exact_npm_install = f"npm install --save-exact {package_name}@{sdk_version}"
for source, contents in {
    "README": readme,
    "configuration guide": configuration,
    "agent integration guide": guide,
    "product integration guide": product_guide,
}.items():
    assert exact_npm_install in contents, f"{source} lacks the exact npm install command"

for marker in (
    "Pystone.Analytics",
    "pystone_analytics",
    "setConsent()",
    "SetConsent()",
    "set_consent()",
    "DisposeAsync()",
    "close()",
    "accepted=true",
    "Staging",
):
    assert marker in guide, f"Agent guide lacks required runtime contract: {marker}"

assert "NuGet.org" in configuration and "PyPI" in configuration
assert "不要尝试从 npm 安装 .NET/Python" in configuration
assert "不使用 `data-umami-event`" in product_guide
assert "会将它视为绕过中央 Schema 并阻断" in product_guide

node_client = (SDK_ROOT / "typescript/src/node/client.ts").read_text(encoding="utf-8")
dotnet_policy = (SDK_ROOT / "dotnet/Pystone.Analytics/PolicyEngine.cs").read_text(
    encoding="utf-8"
)
python_policy = (SDK_ROOT / "python/src/pystone_analytics/policy.py").read_text(
    encoding="utf-8"
)
assert "MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000" in node_client
assert "MAX_RETRY_BASE_MS = 24 * 60 * 60 * 1000" in node_client
assert "_options.MaxEventAge > TimeSpan.FromDays(30)" in dotnet_policy
assert "_options.RetryBase > TimeSpan.FromDays(1)" in dotnet_policy
assert "30 * 86_400" in python_policy and "86_400" in python_policy
for marker in ("最大 30 天", "最大 24 小时", "64 MiB"):
    assert marker in configuration, f"Configuration guide lacks reliability bound: {marker}"

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
    CONFIGURATION,
    CICD,
    SDK_ROOT / "README.md",
):
    validate_local_links(document)

print(
    f"Validated SDK docs v{sdk_version}: "
    f"{len(rows)} events, policy v{policy['policy_version']}, and local links"
)
