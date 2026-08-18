from __future__ import annotations

from collections import deque
from collections.abc import Iterator, Mapping
import json
import math
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from pystone_analytics import (
    AnalyticsClient,
    AnalyticsConfig,
    ConsentState,
    TransportOutcome,
    TransportResult,
    UmamiHttpTransport,
    derive_installation_subject_id,
    derive_user_subject_id,
)


class FakeTransport:
    def __init__(self) -> None:
        self.batches: list[list[dict[str, object]]] = []
        self.results: deque[TransportResult] = deque()
        self.resets = 0

    def send(self, requests: list[dict[str, object]]) -> TransportResult:
        self.batches.append(requests)
        return self.results.popleft() if self.results else TransportResult(
            TransportOutcome.SUCCESS
        )

    def reset_session(self) -> None:
        self.resets += 1


class BlockingTransport:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def send(self, requests: list[dict[str, object]]) -> TransportResult:
        self.started.set()
        self.release.wait(timeout=2)
        return TransportResult(TransportOutcome.SUCCESS)


class NeverCompletingTransport:
    def __init__(self) -> None:
        self.started = threading.Event()

    def send(self, requests: list[dict[str, object]]) -> TransportResult:
        self.started.set()
        threading.Event().wait()
        raise AssertionError("unreachable")


class MalformedThenSuccessTransport:
    def __init__(self) -> None:
        self.calls = 0

    def send(self, requests: list[dict[str, object]]) -> object:
        self.calls += 1
        return object() if self.calls == 1 else TransportResult(TransportOutcome.SUCCESS)


class BlockingProperties(Mapping[str, object]):
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def __getitem__(self, key: str) -> object:
        if key != "feature":
            raise KeyError(key)
        return "scan"

    def __iter__(self) -> Iterator[str]:
        return iter(("feature",))

    def __len__(self) -> int:
        return 1

    def __contains__(self, key: object) -> bool:
        self.started.set()
        self.release.wait(timeout=2)
        return key == "feature"


class FakeResponse:
    def __init__(self, body: bytes) -> None:
        self.body = body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self, amount: int = -1) -> bytes:
        return self.body if amount < 0 else self.body[:amount]


def config(**overrides: object) -> AnalyticsConfig:
    values: dict[str, object] = {
        "endpoint": "https://umami.example.test",
        "website_id": "123e4567-e89b-42d3-a456-426614174000",
        "hostname": "cli.example.test",
        "product": "test-product",
        "environment": "staging",
        "surface": "cli",
        "product_version": "1.0.0",
        "user_agent": "Test/1.0 Analytics/0.1.1",
        "flush_interval_seconds": 3600,
    }
    values.update(overrides)
    return AnalyticsConfig(**values)


class SdkTests(unittest.TestCase):
    def test_consent_policy_and_flush(self) -> None:
        transport = FakeTransport()
        client = AnalyticsClient(config(), transport)
        self.addCleanup(client.close)
        self.assertEqual(
            client.track("feature_used", {"feature": "scan"}).code,
            "consent_not_granted",
        )
        client.set_consent(ConsentState.GRANTED)
        result = client.track(
            "operation_completed",
            {"feature": "scan", "duration_bucket": "1_3s"},
        )
        self.assertTrue(result.accepted)
        self.assertIsNotNone(result.event_id)
        self.assertFalse(
            client.track("feature_used", {"feature": "person@example.com"}).accepted
        )
        client.flush()
        self.assertEqual(client.pending_count, 0)
        self.assertEqual(len(transport.batches), 1)

    def test_retry_and_withdrawal(self) -> None:
        transport = FakeTransport()
        transport.results.append(TransportResult(TransportOutcome.RETRYABLE))
        now = [1000.0]
        client = AnalyticsClient(
            config(initial_consent=ConsentState.GRANTED, retry_base_seconds=10),
            transport,
            clock=lambda: now[0],
            random_value=lambda: 0,
        )
        self.addCleanup(client.close)
        client.track("feature_used", {"feature": "scan"})
        client.flush()
        self.assertEqual(client.pending_count, 1)
        client.set_consent(ConsentState.WITHDRAWN)
        self.assertEqual(client.pending_count, 0)
        self.assertEqual(transport.resets, 1)

    def test_persistent_queue_is_restored_and_removed_on_withdrawal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "analytics.json"
            transport = FakeTransport()
            transport.results.append(TransportResult(TransportOutcome.RETRYABLE))
            first = AnalyticsClient(
                config(
                    initial_consent=ConsentState.GRANTED,
                    persistent_queue_path=path,
                    retry_base_seconds=60,
                ),
                transport,
            )
            first.track("feature_used", {"feature": "scan"})
            first.flush()
            self.assertTrue(path.exists())
            first.close()

            second = AnalyticsClient(
                config(
                    initial_consent=ConsentState.GRANTED,
                    persistent_queue_path=path,
                ),
                FakeTransport(),
            )
            self.assertEqual(second.pending_count, 1)
            second.set_consent(ConsentState.WITHDRAWN)
            self.assertFalse(path.exists())
            second.close()

    def test_identity_is_scoped_and_fits_umami(self) -> None:
        first = derive_installation_subject_id("product-a", "installation")
        second = derive_installation_subject_id("product-b", "installation")
        self.assertEqual(len(first), 43)
        self.assertNotEqual(first, second)
        self.assertEqual(len(derive_user_subject_id(bytes(32), "user-1")), 43)

    def test_track_returns_while_network_is_blocked(self) -> None:
        transport = BlockingTransport()
        client = AnalyticsClient(
            config(initial_consent=ConsentState.GRANTED),
            transport,
        )
        result: list[object] = []
        caller = threading.Thread(
            target=lambda: result.append(
                client.track("feature_used", {"feature": "scan"})
            )
        )
        try:
            caller.start()
            caller.join(timeout=0.5)
            self.assertFalse(caller.is_alive(), "track() waited for the network")
            self.assertTrue(result and result[0].accepted)
            self.assertTrue(transport.started.wait(timeout=2))
        finally:
            transport.release.set()
            caller.join(timeout=2)
            client.close()

    def test_queue_is_bounded_and_diagnostic_failure_is_isolated(self) -> None:
        diagnostics = 0

        def broken_diagnostic(_diagnostic: object) -> None:
            nonlocal diagnostics
            diagnostics += 1
            raise RuntimeError("host diagnostic failure")

        client = AnalyticsClient(
            config(
                initial_consent=ConsentState.GRANTED,
                queue_capacity=3,
                on_diagnostic=broken_diagnostic,
            ),
            FakeTransport(),
        )
        try:
            for index in range(10_000):
                self.assertTrue(
                    client.track("feature_used", {"feature": f"scan_{index}"}).accepted
                )
            self.assertLessEqual(client.pending_count, 3)
            self.assertGreater(diagnostics, 0)
        finally:
            client.close()

    def test_withdrawal_racing_with_track_leaves_no_event(self) -> None:
        client = AnalyticsClient(
            config(initial_consent=ConsentState.GRANTED), FakeTransport()
        )
        properties = BlockingProperties()
        result: list[object] = []
        tracking = threading.Thread(
            target=lambda: result.append(client.track("feature_used", properties))
        )
        withdrawal = threading.Thread(
            target=lambda: client.set_consent(ConsentState.WITHDRAWN)
        )
        try:
            tracking.start()
            self.assertTrue(properties.started.wait(timeout=2))
            withdrawal.start()
            properties.release.set()
            tracking.join(timeout=2)
            withdrawal.join(timeout=2)
            self.assertTrue(result and result[0].accepted)
            self.assertEqual(client.pending_count, 0)
        finally:
            properties.release.set()
            client.close()

    def test_close_is_bounded_for_uncooperative_transport_and_is_terminal(self) -> None:
        transport = NeverCompletingTransport()
        client = AnalyticsClient(
            config(
                initial_consent=ConsentState.GRANTED,
                timeout_seconds=0.1,
            ),
            transport,
        )
        client.track("feature_used", {"feature": "scan"})
        self.assertTrue(transport.started.wait(timeout=2))
        started = time.monotonic()
        client.close()
        self.assertLess(time.monotonic() - started, 1.0)
        client.close()
        self.assertEqual(
            client.track("feature_used", {"feature": "scan"}).code,
            "disabled",
        )

    def test_worker_survives_unexpected_transport_result(self) -> None:
        diagnostics: list[str] = []
        transport = MalformedThenSuccessTransport()
        client = AnalyticsClient(
            config(
                initial_consent=ConsentState.GRANTED,
                on_diagnostic=lambda value: diagnostics.append(value.detail or value.code),
            ),
            transport,  # type: ignore[arg-type]
        )
        try:
            client.track("feature_used", {"feature": "scan"})
            deadline = time.monotonic() + 2
            while "flush" not in diagnostics and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIn("flush", diagnostics)
            self.assertTrue(client._worker.is_alive())
            client._wake.set()
            deadline = time.monotonic() + 2
            while client.pending_count and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(client.pending_count, 0)
        finally:
            client.close()

    def test_explicit_flush_swallows_unexpected_transport_result(self) -> None:
        diagnostics: list[str] = []
        client = AnalyticsClient(
            config(
                initial_consent=ConsentState.GRANTED,
                on_diagnostic=lambda value: diagnostics.append(value.detail or value.code),
            ),
            MalformedThenSuccessTransport(),  # type: ignore[arg-type]
        )
        try:
            client.track("feature_used", {"feature": "scan"})
            client.flush()
            self.assertEqual(client.pending_count, 1)
            self.assertIn("flush", diagnostics)
        finally:
            client.close()

    def test_invalid_reliability_configuration_fails_fast(self) -> None:
        for overrides in (
            {"queue_capacity": 10_001},
            {"batch_size": 0},
            {"max_retries": 11},
            {"timeout_seconds": math.nan},
            {"flush_interval_seconds": math.inf},
            {"max_event_age_seconds": 30 * 86_400 + 0.1},
            {"retry_base_seconds": 86_400 + 0.1},
            {"website_id": "00000000-0000-0000-0000-000000000000"},
            {"initial_consent": "granted"},
        ):
            with self.subTest(overrides=overrides):
                with self.assertRaises(ValueError):
                    AnalyticsClient(config(**overrides), FakeTransport())

    def test_oversized_or_corrupt_persistent_queue_is_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "analytics.json"
            with path.open("wb") as stream:
                stream.seek(64 * 1024 * 1024)
                stream.write(b"x")
            diagnostics: list[str] = []
            client = AnalyticsClient(
                config(
                    initial_consent=ConsentState.GRANTED,
                    persistent_queue_path=path,
                    on_diagnostic=lambda value: diagnostics.append(value.detail or value.code),
                ),
                FakeTransport(),
            )
            try:
                self.assertFalse(path.exists())
                self.assertIn("queue_corrupt", diagnostics)
            finally:
                client.close()

    def test_tampered_persistent_queue_cannot_bypass_privacy_policy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "analytics.json"
            transport = FakeTransport()
            transport.results.append(TransportResult(TransportOutcome.RETRYABLE))
            first = AnalyticsClient(
                config(
                    initial_consent=ConsentState.GRANTED,
                    persistent_queue_path=path,
                    retry_base_seconds=60,
                ),
                transport,
            )
            first.track("feature_used", {"feature": "scan"})
            first.flush()
            first.close()
            content = json.loads(path.read_text(encoding="utf-8"))
            content[0]["request"]["payload"]["data"]["feature"] = "person@example.com"
            path.write_text(json.dumps(content), encoding="utf-8")

            diagnostics: list[str] = []
            second = AnalyticsClient(
                config(
                    initial_consent=ConsentState.GRANTED,
                    persistent_queue_path=path,
                    on_diagnostic=lambda value: diagnostics.append(value.detail or value.code),
                ),
                FakeTransport(),
            )
            try:
                self.assertEqual(second.pending_count, 0)
                self.assertFalse(path.exists())
                self.assertIn("queue_corrupt", diagnostics)
            finally:
                second.close()

    def test_http_transport_bounds_success_response_and_classifies_statuses(self) -> None:
        transport = UmamiHttpTransport(config())
        request = [{"type": "event", "payload": {"website": config().website_id}}]
        with patch(
            "pystone_analytics.transport.urlopen",
            side_effect=[
                FakeResponse(b"not-json"),
                FakeResponse(b"x" * (65 * 1024)),
                HTTPError("url", 408, "timeout", {}, None),
                HTTPError("url", 429, "limited", {"Retry-After": "1"}, None),
                HTTPError("url", 503, "down", {}, None),
                HTTPError("url", 400, "bad", {}, None),
            ],
        ):
            self.assertEqual(transport.send(request).outcome, TransportOutcome.SUCCESS)
            self.assertEqual(transport.send(request).outcome, TransportOutcome.SUCCESS)
            self.assertEqual(transport.send(request).outcome, TransportOutcome.RETRYABLE)
            self.assertEqual(transport.send(request).outcome, TransportOutcome.RETRYABLE)
            self.assertEqual(transport.send(request).outcome, TransportOutcome.RETRYABLE)
            self.assertEqual(transport.send(request).outcome, TransportOutcome.PERMANENT)


if __name__ == "__main__":
    unittest.main()
