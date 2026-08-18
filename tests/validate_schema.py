#!/usr/bin/env python3
"""Validate the canonical telemetry schema without third-party dependencies."""

from __future__ import annotations

import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
registry = json.loads((ROOT / "schema/event-registry.json").read_text(encoding="utf-8"))
policy = json.loads((ROOT / "schema/privacy-policy.json").read_text(encoding="utf-8"))

assert registry["schema_version"] >= 1
assert policy["policy_version"] >= 1
assert re.fullmatch(r"[a-z][a-z0-9_]{0,49}", next(iter(registry["events"])))

common = set(policy["common_properties"])
session = set(policy["session_properties"])
forbidden = set(policy["forbidden_key_tokens"])
assert len(common) == len(policy["common_properties"])
assert len(session) == len(policy["session_properties"])
assert {"event_version", "product", "environment", "surface"} <= common
assert policy["limits"]["property_count"] >= len(common)
assert 0 < policy["limits"]["string_value"] <= 500
assert policy["limits"]["number_absolute"] > 0
assert 0 <= policy["limits"]["number_decimal_places"] <= 8
assert 0 < policy["limits"]["subject_id"] <= 50


def validate_property_name(name: str) -> None:
    assert re.fullmatch(r"[a-z][a-z0-9_]{0,63}", name), name
    tokens = set(re.split(r"[_\-.]+", name.lower()))
    assert name.lower() not in forbidden and not tokens & forbidden, name


for prop in session:
    validate_property_name(prop)

for name, definition in registry["events"].items():
    assert re.fullmatch(r"[a-z][a-z0-9_]{0,49}", name), name
    assert isinstance(definition["version"], int) and definition["version"] >= 1
    assert isinstance(definition["purpose"], str) and definition["purpose"].strip()
    assert definition["identity_scope"] in {"session", "installation", "account"}
    required = definition["required"]
    optional = definition["optional"]
    assert len(required) == len(set(required)), name
    assert len(optional) == len(set(optional)), name
    assert not set(required) & set(optional), name
    assert len(common) + len(required) + len(optional) <= policy["limits"]["property_count"]
    for prop in required + optional:
        validate_property_name(prop)

for pattern in policy["sensitive_value_patterns"]:
    re.compile(pattern)

print(f"Validated {len(registry['events'])} events and privacy policy v{policy['policy_version']}")
