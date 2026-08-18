from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, Mapping, Protocol, TypeAlias


AnalyticsValue: TypeAlias = str | int | float | bool | None
AnalyticsProperties: TypeAlias = Mapping[str, AnalyticsValue]


class ConsentState(str, Enum):
    UNKNOWN = "unknown"
    GRANTED = "granted"
    DENIED = "denied"
    WITHDRAWN = "withdrawn"


@dataclass(frozen=True)
class Diagnostic:
    code: str
    event_name: str | None = None
    detail: str | None = None


DiagnosticHandler: TypeAlias = Callable[[Diagnostic], None]


@dataclass(frozen=True)
class TrackResult:
    accepted: bool
    code: str
    event_id: str | None = None


@dataclass(frozen=True)
class EventDefinition:
    version: int
    purpose: str
    identity_scope: str
    required: tuple[str, ...] = ()
    optional: tuple[str, ...] = ()


@dataclass(frozen=True)
class AnalyticsConfig:
    endpoint: str
    website_id: str
    hostname: str
    product: str
    environment: str
    surface: str
    product_version: str
    user_agent: str
    sdk_version: str = "0.1.0"
    platform: str | None = None
    architecture: str | None = None
    locale: str | None = None
    channel: str | None = None
    policy_version: int = 1
    initial_consent: ConsentState = ConsentState.UNKNOWN
    allow_insecure_localhost: bool = False
    allow_utm: bool = False
    queue_capacity: int = 1_000
    batch_size: int = 25
    flush_interval_seconds: float = 5.0
    timeout_seconds: float = 3.0
    max_retries: int = 3
    max_event_age_seconds: float = 24 * 60 * 60
    retry_base_seconds: float = 0.5
    persistent_queue_path: Path | None = None
    on_diagnostic: DiagnosticHandler | None = None


class TransportOutcome(str, Enum):
    SUCCESS = "success"
    RETRYABLE = "retryable"
    PERMANENT = "permanent"


@dataclass(frozen=True)
class TransportResult:
    outcome: TransportOutcome
    retry_after_seconds: float | None = None
    partial_errors: int = 0


class AnalyticsTransport(Protocol):
    def send(self, requests: list[dict[str, object]]) -> TransportResult: ...

    def reset_session(self) -> None: ...
