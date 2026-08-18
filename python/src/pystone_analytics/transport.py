from __future__ import annotations

import json
import re
import socket
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .models import AnalyticsConfig, AnalyticsTransport, TransportOutcome, TransportResult


class UmamiHttpTransport(AnalyticsTransport):
    _MAX_RESPONSE_BYTES = 64 * 1024
    def __init__(self, config: AnalyticsConfig) -> None:
        self._url = f"{config.endpoint.rstrip('/')}/api/batch"
        self._user_agent = config.user_agent
        self._timeout = config.timeout_seconds
        self._cache: str | None = None
        self._session_generation = 0

    def send(self, requests: list[dict[str, object]]) -> TransportResult:
        if not requests:
            return TransportResult(TransportOutcome.SUCCESS)
        generation = self._session_generation
        headers = {
            "Content-Type": "application/json",
            "User-Agent": self._user_agent,
        }
        if self._cache:
            headers["x-umami-cache"] = self._cache
        request = Request(
            self._url,
            data=json.dumps(requests, separators=(",", ":")).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urlopen(request, timeout=self._timeout) as response:
                raw = response.read(self._MAX_RESPONSE_BYTES + 1)
                try:
                    body = (
                        json.loads(raw.decode("utf-8"))
                        if raw and len(raw) <= self._MAX_RESPONSE_BYTES
                        else {}
                    )
                except (UnicodeDecodeError, json.JSONDecodeError):
                    body = {}
                if not isinstance(body, dict):
                    body = {}
                cache = body.get("cache")
                if (
                    generation == self._session_generation
                    and isinstance(cache, str)
                    and re.fullmatch(
                        r"[A-Za-z0-9_.-]{1,2048}", cache
                    )
                ):
                    self._cache = cache
                return TransportResult(
                    TransportOutcome.SUCCESS,
                    partial_errors=self._partial_errors(body.get("errors")),
                )
        except HTTPError as error:
            if error.code in {408, 429} or error.code >= 500:
                retry_after = self._retry_after(error.headers.get("Retry-After"))
                return TransportResult(
                    TransportOutcome.RETRYABLE,
                    retry_after_seconds=retry_after,
                )
            return TransportResult(TransportOutcome.PERMANENT)
        except (URLError, TimeoutError, socket.timeout, OSError):
            return TransportResult(TransportOutcome.RETRYABLE)

    def reset_session(self) -> None:
        self._session_generation += 1
        self._cache = None

    @staticmethod
    def _partial_errors(value: object) -> int:
        return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0

    @staticmethod
    def _retry_after(value: str | None) -> float | None:
        if not value:
            return None
        try:
            seconds = float(value)
            return min(max(seconds, 0.0), 60.0)
        except ValueError:
            pass
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            return min(max((date - datetime.now(timezone.utc)).total_seconds(), 0.0), 60.0)
        except (TypeError, ValueError, OverflowError):
            return None
