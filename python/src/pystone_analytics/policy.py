from __future__ import annotations

from datetime import datetime, timezone
import json
import math
import re
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit
from uuid import UUID, uuid4

from ._generated_policy import EVENT_REGISTRY_JSON, PRIVACY_POLICY_JSON
from .models import AnalyticsConfig, AnalyticsProperties, EventDefinition


EVENT_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
PROPERTY_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
CONTEXT_VALUE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
HOSTNAME_PATTERN = re.compile(r"^[A-Za-z0-9.-]+$")
SUBJECT_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


class PolicyError(ValueError):
    def __init__(self, code: str, detail: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


class PolicyEngine:
    def __init__(self, config: AnalyticsConfig) -> None:
        self.config = config
        registry = json.loads(EVENT_REGISTRY_JSON)
        self.policy: dict[str, object] = json.loads(PRIVACY_POLICY_JSON)
        self.events: dict[str, EventDefinition] = {
            name: EventDefinition(
                version=value["version"],
                purpose=value["purpose"],
                identity_scope=value["identity_scope"],
                required=tuple(value["required"]),
                optional=tuple(value["optional"]),
            )
            for name, value in registry["events"].items()
        }
        self.forbidden_tokens = set(self.policy["forbidden_key_tokens"])
        self.session_properties = set(self.policy["session_properties"])
        self.sensitive_patterns = [
            re.compile(pattern) for pattern in self.policy["sensitive_value_patterns"]
        ]
        self.endpoint = self._validate_config()

    def create_event(
        self,
        event_name: str,
        properties: AnalyticsProperties,
        subject_id: str | None,
        occurred_at: datetime | None = None,
    ) -> tuple[dict[str, object], str]:
        definition = self._validate_event(event_name, properties)
        if subject_id is not None:
            self.validate_subject_id(subject_id)
        event_id = str(uuid4())
        data: dict[str, object] = {
            "event_version": definition.version,
            "product": self.config.product,
            "environment": self.config.environment,
            "surface": self.config.surface,
            "product_version": self.config.product_version,
            "sdk_version": self.config.sdk_version,
            "consent_state": "granted",
            "policy_version": self.policy["policy_version"],
        }
        for key, value in (
            ("platform", self.config.platform),
            ("architecture", self.config.architecture),
            ("locale", self.config.locale),
            ("channel", self.config.channel),
        ):
            if value:
                data[key] = value
        data.update(properties)
        if len(data) > self._limit("property_count"):
            raise PolicyError("invalid_property", "property_count")
        timestamp = occurred_at or datetime.now(timezone.utc)
        payload: dict[str, object] = {
            "website": self.config.website_id,
            "hostname": self.config.hostname,
            "url": f"/events/{event_name}",
            "name": event_name,
            "timestamp": int(timestamp.timestamp()),
            "data": data,
        }
        if subject_id:
            payload["id"] = subject_id
        return {"type": "event", "payload": payload}, event_id

    def create_identify(
        self, subject_id: str, properties: AnalyticsProperties
    ) -> dict[str, object]:
        self.validate_subject_id(subject_id)
        self._validate_properties(properties, self.session_properties)
        return {
            "type": "identify",
            "payload": {
                "website": self.config.website_id,
                "id": subject_id,
                "data": dict(properties),
            },
        }

    def create_page(
        self, path: str, title: str | None, subject_id: str | None
    ) -> dict[str, object]:
        if subject_id is not None:
            self.validate_subject_id(subject_id)
        normalized_path, normalized_title = self.normalize_page(path, title)
        payload: dict[str, object] = {
            "website": self.config.website_id,
            "hostname": self.config.hostname,
            "url": normalized_path,
        }
        if normalized_title:
            payload["title"] = normalized_title
        if subject_id:
            payload["id"] = subject_id
        return {"type": "event", "payload": payload}

    def validate_persisted_request(self, request: object) -> None:
        if not isinstance(request, dict) or set(request) != {"type", "payload"}:
            raise PolicyError("invalid_property", "queue_request")
        request_type = request.get("type")
        payload = request.get("payload")
        if not isinstance(payload, dict) or payload.get("website") != self.config.website_id:
            raise PolicyError("invalid_property", "queue_payload")

        if request_type == "identify":
            if set(payload) != {"website", "id", "data"}:
                raise PolicyError("invalid_property", "queue_identify")
            subject_id = payload.get("id")
            data = payload.get("data")
            if not isinstance(subject_id, str) or not isinstance(data, dict):
                raise PolicyError("invalid_property", "queue_identify")
            if self.create_identify(subject_id, data) != request:
                raise PolicyError("invalid_property", "queue_identify")
            return

        if request_type != "event":
            raise PolicyError("invalid_property", "queue_type")
        name = payload.get("name")
        if isinstance(name, str):
            expected_keys = {"website", "hostname", "url", "name", "timestamp", "data"}
            if payload.get("id") is not None:
                expected_keys.add("id")
            if set(payload) != expected_keys:
                raise PolicyError("invalid_property", "queue_event")
            timestamp = payload.get("timestamp")
            data = payload.get("data")
            subject_id = payload.get("id")
            if (
                not isinstance(timestamp, int)
                or isinstance(timestamp, bool)
                or not isinstance(data, dict)
                or (subject_id is not None and not isinstance(subject_id, str))
            ):
                raise PolicyError("invalid_property", "queue_event")
            properties = self._validate_canonical_event_data(name, data)
            rebuilt, _ = self.create_event(
                name,
                properties,
                subject_id,
                datetime.fromtimestamp(timestamp, timezone.utc),
            )
            if rebuilt != request:
                raise PolicyError("invalid_property", "queue_event")
            return

        expected_keys = {"website", "hostname", "url"}
        if payload.get("title") is not None:
            expected_keys.add("title")
        if payload.get("id") is not None:
            expected_keys.add("id")
        if set(payload) != expected_keys or not isinstance(payload.get("url"), str):
            raise PolicyError("invalid_property", "queue_page")
        subject_id = payload.get("id")
        title = payload.get("title")
        if (subject_id is not None and not isinstance(subject_id, str)) or (
            title is not None and not isinstance(title, str)
        ):
            raise PolicyError("invalid_property", "queue_page")
        if self.create_page(payload["url"], title, subject_id) != request:
            raise PolicyError("invalid_property", "queue_page")

    def normalize_page(self, path: str, title: str | None) -> tuple[str, str | None]:
        parsed = urlsplit(urljoin("https://analytics.invalid/", path))
        query: list[tuple[str, str]] = []
        if self.config.allow_utm:
            allowed = set(self.policy["allowed_url_query_keys"])
            query = [
                (key, value)
                for key, value in parse_qsl(parsed.query, keep_blank_values=False)
                if key in allowed
                and len(value) <= 100
                and not self._contains_sensitive_value(value)
            ]
        result = parsed.path or "/"
        if query:
            result = f"{result}?{urlencode(query)}"
        if len(result) > self._limit("page_path"):
            raise PolicyError("invalid_page", "path_length")
        if title and (
            len(title) > self._limit("page_title")
            or self._contains_sensitive_value(title)
        ):
            raise PolicyError("invalid_page", "title")
        return result, title

    def validate_subject_id(self, subject_id: str) -> None:
        if (
            not subject_id
            or len(subject_id) > self._limit("subject_id")
            or not SUBJECT_PATTERN.fullmatch(subject_id)
            or self._contains_sensitive_value(subject_id)
        ):
            raise PolicyError("invalid_subject_id")

    def _validate_event(
        self, event_name: str, properties: AnalyticsProperties
    ) -> EventDefinition:
        if (
            not EVENT_NAME_PATTERN.fullmatch(event_name)
            or len(event_name) > self._limit("event_name")
        ):
            raise PolicyError("invalid_event_name")
        definition = self.events.get(event_name)
        if definition is None:
            raise PolicyError("unregistered_event")
        for required in definition.required:
            if required not in properties:
                raise PolicyError("missing_property", required)
        self._validate_properties(
            properties, set(definition.required) | set(definition.optional)
        )
        return definition

    def _validate_canonical_event_data(
        self, event_name: str, data: dict[str, object]
    ) -> dict[str, object]:
        definition = self.events.get(event_name)
        if definition is None:
            raise PolicyError("unregistered_event")
        event_keys = set(definition.required) | set(definition.optional)
        expected_common: dict[str, object] = {
            "event_version": definition.version,
            "product": self.config.product,
            "environment": self.config.environment,
            "surface": self.config.surface,
            "product_version": self.config.product_version,
            "sdk_version": self.config.sdk_version,
            "consent_state": "granted",
            "policy_version": self.policy["policy_version"],
        }
        for key, value in (
            ("platform", self.config.platform),
            ("architecture", self.config.architecture),
            ("locale", self.config.locale),
            ("channel", self.config.channel),
        ):
            if value:
                expected_common[key] = value
        common = set(self.policy["common_properties"])
        properties: dict[str, object] = {}
        for key, value in expected_common.items():
            if key not in event_keys and data.get(key) != value:
                raise PolicyError("invalid_property", key)
        for key, value in data.items():
            if key in event_keys:
                properties[key] = value
            elif key not in common or key not in expected_common:
                raise PolicyError("unknown_property", key)
        self._validate_event(event_name, properties)
        return properties

    def _validate_properties(
        self, properties: AnalyticsProperties, allowed: set[str]
    ) -> None:
        if len(properties) > self._limit("property_count"):
            raise PolicyError("invalid_property", "property_count")
        for key, value in properties.items():
            if key not in allowed:
                raise PolicyError("unknown_property", key)
            self._validate_key(key)
            self._validate_value(key, value)

    def _validate_key(self, key: str) -> None:
        if (
            not PROPERTY_NAME_PATTERN.fullmatch(key)
            or len(key) > self._limit("property_name")
        ):
            raise PolicyError("invalid_property", key)
        tokens = re.split(r"[_\-.]+", key.lower())
        if key.lower() in self.forbidden_tokens or any(
            token in self.forbidden_tokens for token in tokens
        ):
            raise PolicyError("sensitive_key", key)

    def _validate_value(self, key: str, value: object) -> None:
        if value is None or isinstance(value, bool):
            return
        if isinstance(value, int):
            if abs(value) > self._limit("number_absolute"):
                raise PolicyError("invalid_property", key)
            return
        if isinstance(value, float):
            if (
                not math.isfinite(value)
                or abs(value) > self._limit("number_absolute")
            ):
                raise PolicyError("invalid_property", key)
            text = format(value, "f").rstrip("0")
            if (
                "." in text
                and len(text.split(".", 1)[1])
                > self._limit("number_decimal_places")
            ):
                raise PolicyError("invalid_property", key)
            return
        if not isinstance(value, str) or len(value) > self._limit("string_value"):
            raise PolicyError("invalid_property", key)
        if self._contains_sensitive_value(value):
            raise PolicyError("sensitive_value", key)

    def _contains_sensitive_value(self, value: str) -> bool:
        return any(pattern.search(value) for pattern in self.sensitive_patterns)

    def _limit(self, name: str) -> int:
        return self.policy["limits"][name]

    def _validate_config(self) -> str:
        try:
            parsed = urlsplit(self.config.endpoint)
            hostname = parsed.hostname
            _ = parsed.port
        except ValueError as error:
            raise ValueError("invalid endpoint") from error
        localhost = hostname in {"localhost", "127.0.0.1", "::1"}
        if parsed.scheme != "https" and not (
            self.config.allow_insecure_localhost and localhost and parsed.scheme == "http"
        ):
            raise ValueError("endpoint must use HTTPS except explicit localhost development")
        if (
            hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("endpoint must not contain a path, query or fragment")
        try:
            UUID(self.config.website_id)
        except ValueError as error:
            raise ValueError("invalid website_id") from error
        for value in (self.config.product, self.config.environment, self.config.surface):
            if not SLUG_PATTERN.fullmatch(value) or len(value) > 64:
                raise ValueError("invalid product context slug")
        if (
            not self.config.hostname
            or len(self.config.hostname) > 253
            or not HOSTNAME_PATTERN.fullmatch(self.config.hostname)
        ):
            raise ValueError("invalid hostname")
        for value in (
            self.config.product_version,
            self.config.sdk_version,
            self.config.platform,
            self.config.architecture,
            self.config.locale,
            self.config.channel,
        ):
            if value is not None and (
                len(value) > 64 or not CONTEXT_VALUE_PATTERN.fullmatch(value)
            ):
                raise ValueError("invalid analytics context value")
        if (
            not self.config.user_agent.strip()
            or len(self.config.user_agent) > 200
            or "\r" in self.config.user_agent
            or "\n" in self.config.user_agent
        ):
            raise ValueError("invalid user_agent")
        if self.config.policy_version != self.policy["policy_version"]:
            raise ValueError("policy version mismatch")
        if (
            not isinstance(self.config.queue_capacity, int)
            or isinstance(self.config.queue_capacity, bool)
            or not 1 <= self.config.queue_capacity <= 10_000
            or not isinstance(self.config.batch_size, int)
            or isinstance(self.config.batch_size, bool)
            or not 1 <= self.config.batch_size <= 100
        ):
            raise ValueError("invalid queue configuration")
        if (
            not self._finite_between(self.config.flush_interval_seconds, 0.001, 86_400)
            or not self._finite_between(self.config.timeout_seconds, 0.001, 60)
            or not isinstance(self.config.max_retries, int)
            or isinstance(self.config.max_retries, bool)
            or not 0 <= self.config.max_retries <= 10
            or not self._finite_between(self.config.max_event_age_seconds, 0.001, 30 * 86_400)
            or not self._finite_between(self.config.retry_base_seconds, 0.001, 86_400)
        ):
            raise ValueError("invalid reliability configuration")
        return f"{parsed.scheme}://{parsed.netloc}"

    @staticmethod
    def _finite_between(value: object, minimum: float, maximum: float) -> bool:
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and minimum <= value <= maximum
        )
