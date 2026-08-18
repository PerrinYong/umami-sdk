from __future__ import annotations

from collections import deque
from dataclasses import asdict, dataclass
import json
import math
import os
from pathlib import Path
import random
import threading
import time
from typing import Callable
from uuid import uuid4
from uuid import UUID

from .models import (
    AnalyticsConfig,
    AnalyticsProperties,
    AnalyticsTransport,
    ConsentState,
    Diagnostic,
    TrackResult,
    TransportOutcome,
    TransportResult,
)
from .policy import PolicyEngine, PolicyError
from .transport import UmamiHttpTransport


@dataclass
class _QueueItem:
    queue_id: str
    request: dict[str, object]
    created_at: float
    attempts: int
    next_attempt_at: float
    event_name: str | None = None


class AnalyticsClient:
    _MAX_PERSISTENT_QUEUE_BYTES = 64 * 1024 * 1024
    def __init__(
        self,
        config: AnalyticsConfig,
        transport: AnalyticsTransport | None = None,
        *,
        clock: Callable[[], float] = time.time,
        random_value: Callable[[], float] = random.random,
    ) -> None:
        self._config = config
        self._policy = PolicyEngine(config)
        self._transport = transport or UmamiHttpTransport(config)
        self._clock = clock
        self._random = random_value
        self._consent = config.initial_consent
        self._subject_id: str | None = None
        self._disabled = False
        self._queue: deque[_QueueItem] = deque()
        self._lock = threading.RLock()
        self._flush_lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        if self._consent is ConsentState.GRANTED:
            self._load_queue()
        else:
            self._delete_persistent_queue()
        self._worker = threading.Thread(
            target=self._worker_loop,
            name="pystone-analytics",
            daemon=True,
        )
        self._worker.start()

    @property
    def pending_count(self) -> int:
        with self._lock:
            return len(self._queue)

    def track(
        self, event_name: str, properties: AnalyticsProperties | None = None
    ) -> TrackResult:
        with self._lock:
            if not self._can_accept:
                return self._state_rejection(event_name)
            try:
                request, event_id = self._policy.create_event(
                    event_name,
                    properties or {},
                    self._subject_id,
                )
                self._enqueue(request, event_name=event_name, queue_id=event_id)
                return TrackResult(True, "accepted", event_id)
            except PolicyError as error:
                self._emit(Diagnostic(error.code, event_name, error.detail))
                return TrackResult(False, error.code)
            except Exception:
                self._emit(Diagnostic("invalid_property", event_name))
                return TrackResult(False, "invalid_property")

    def identify(
        self, subject_id: str, properties: AnalyticsProperties | None = None
    ) -> TrackResult:
        with self._lock:
            if not self._can_accept:
                return self._state_rejection()
            try:
                request = self._policy.create_identify(subject_id, properties or {})
                if self._subject_id is not None and self._subject_id != subject_id:
                    self._queue.clear()
                    self._reset_transport_session()
                self._subject_id = subject_id
                self._enqueue(request)
                return TrackResult(True, "accepted")
            except PolicyError as error:
                self._emit(Diagnostic(error.code, detail=error.detail))
                return TrackResult(False, error.code)
            except Exception:
                self._emit(Diagnostic("invalid_subject_id"))
                return TrackResult(False, "invalid_subject_id")

    def page(self, path: str = "/", title: str | None = None) -> TrackResult:
        with self._lock:
            if not self._can_accept:
                return self._state_rejection()
            try:
                self._enqueue(self._policy.create_page(path, title, self._subject_id))
                return TrackResult(True, "accepted")
            except PolicyError as error:
                self._emit(Diagnostic(error.code, detail=error.detail))
                return TrackResult(False, error.code)
            except Exception:
                self._emit(Diagnostic("invalid_page"))
                return TrackResult(False, "invalid_page")

    def set_consent(self, state: ConsentState) -> None:
        with self._lock:
            if self._disabled:
                return
            self._consent = state
            if state is ConsentState.GRANTED:
                self._wake.set()
                return
            self._subject_id = None
            self._queue.clear()
        self._reset_transport_session()
        self._delete_persistent_queue()

    def flush(self) -> None:
        if not self._can_accept:
            return
        if not self._flush_lock.acquire(blocking=False):
            return
        try:
            while self._can_accept:
                self._drop_expired()
                now = self._clock()
                with self._lock:
                    batch = [
                        item
                        for item in self._queue
                        if item.next_attempt_at <= now
                    ][: self._config.batch_size]
                self._persist_queue()
                if not batch:
                    return
                try:
                    result = self._transport.send([item.request for item in batch])
                except Exception:
                    result = TransportResult(TransportOutcome.RETRYABLE)
                if result.outcome is TransportOutcome.SUCCESS:
                    self._remove(batch)
                    if result.partial_errors:
                        self._emit(
                            Diagnostic(
                                "transport_permanent_failure",
                                detail=f"partial:{result.partial_errors}",
                            )
                        )
                    self._persist_queue()
                    continue
                if result.outcome is TransportOutcome.PERMANENT:
                    self._remove(batch)
                    self._emit(Diagnostic("transport_permanent_failure"))
                    self._persist_queue()
                    continue
                self._emit(Diagnostic("transport_retryable_failure"))
                for item in batch:
                    item.attempts += 1
                    if item.attempts > self._config.max_retries:
                        self._remove([item])
                        self._emit(Diagnostic("retry_exhausted", item.event_name))
                        continue
                    exponential = self._config.retry_base_seconds * 2 ** (item.attempts - 1)
                    random_value = self._random()
                    safe_random = (
                        random_value
                        if isinstance(random_value, (int, float))
                        and not isinstance(random_value, bool)
                        and 0 <= random_value <= 1
                        else 0
                    )
                    jitter = exponential * 0.25 * safe_random
                    item.next_attempt_at = now + max(
                        result.retry_after_seconds or 0,
                        exponential + jitter,
                    )
                self._persist_queue()
                return
        except Exception:
            self._emit(Diagnostic("transport_retryable_failure", detail="flush"))
        finally:
            self._flush_lock.release()

    def disable(self) -> None:
        with self._lock:
            self._disabled = True
            self._consent = ConsentState.WITHDRAWN
            self._subject_id = None
            self._queue.clear()
        self._reset_transport_session()
        self._delete_persistent_queue()
        self._stop.set()
        self._wake.set()

    def close(self) -> None:
        started_at = time.monotonic()
        self._stop.set()
        self._wake.set()
        if threading.current_thread() is not self._worker:
            self._worker.join(timeout=self._config.timeout_seconds)
        remaining = self._config.timeout_seconds - (time.monotonic() - started_at)
        if self._can_accept and not self._worker.is_alive() and remaining > 0:
            final_flush = threading.Thread(
                target=self.flush,
                name="pystone-analytics-close",
                daemon=True,
            )
            final_flush.start()
            final_flush.join(timeout=remaining)
        with self._lock:
            self._disabled = True
            self._consent = ConsentState.WITHDRAWN
            self._subject_id = None
            self._queue.clear()
        self._reset_transport_session()

    def __enter__(self) -> "AnalyticsClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @property
    def _can_accept(self) -> bool:
        with self._lock:
            return not self._disabled and self._consent is ConsentState.GRANTED

    def _state_rejection(self, event_name: str | None = None) -> TrackResult:
        code = "disabled" if self._disabled else "consent_not_granted"
        self._emit(Diagnostic(code, event_name))
        return TrackResult(False, code)

    def _enqueue(
        self,
        request: dict[str, object],
        *,
        event_name: str | None = None,
        queue_id: str | None = None,
    ) -> None:
        with self._lock:
            if len(self._queue) >= self._config.queue_capacity:
                self._queue.popleft()
                self._emit(Diagnostic("queue_full", event_name))
            now = self._clock()
            self._queue.append(
                _QueueItem(
                    queue_id=queue_id or str(uuid4()),
                    request=request,
                    created_at=now,
                    attempts=0,
                    next_attempt_at=now,
                    event_name=event_name,
                )
            )
        self._wake.set()

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._wake.wait(self._config.flush_interval_seconds)
                self._wake.clear()
                if self._stop.is_set():
                    break
                time.sleep(0.05)
                self.flush()
            except Exception:
                self._emit(Diagnostic("transport_retryable_failure", detail="worker"))

    def _drop_expired(self) -> None:
        cutoff = self._clock() - self._config.max_event_age_seconds
        with self._lock:
            expired = [item for item in self._queue if item.created_at < cutoff]
        self._remove(expired)
        for item in expired:
            self._emit(Diagnostic("event_expired", item.event_name))

    def _remove(self, items: list[_QueueItem]) -> None:
        ids = {item.queue_id for item in items}
        if not ids:
            return
        with self._lock:
            self._queue = deque(
                item for item in self._queue if item.queue_id not in ids
            )

    def _persist_queue(self) -> None:
        path = self._config.persistent_queue_path
        if path is None:
            return
        temporary: Path | None = None
        try:
            path = path.resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            with self._lock:
                snapshot = [asdict(item) for item in self._queue]
            if not snapshot:
                path.unlink(missing_ok=True)
                return
            encoded = json.dumps(snapshot, separators=(",", ":")).encode("utf-8")
            if len(encoded) > self._MAX_PERSISTENT_QUEUE_BYTES:
                self._emit(
                    Diagnostic(
                        "transport_retryable_failure",
                        detail="queue_persist_oversize",
                    )
                )
                return
            temporary = path.with_name(f"{path.name}.{uuid4().hex}.tmp")
            temporary.write_bytes(encoded)
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        except (OSError, TypeError, ValueError):
            self._emit(Diagnostic("transport_retryable_failure", detail="queue_persist"))
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def _load_queue(self) -> None:
        path = self._config.persistent_queue_path
        if path is None or not path.exists():
            return
        try:
            if path.stat().st_size > self._MAX_PERSISTENT_QUEUE_BYTES:
                raise ValueError("persistent queue exceeds size limit")
            values = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(values, list):
                raise ValueError("persistent queue must be a list")
            if any(not isinstance(value, dict) for value in values):
                raise ValueError("persistent queue contains an invalid item")
            cutoff = self._clock() - self._config.max_event_age_seconds
            loaded = [
                _QueueItem(**value)
                for value in values
                if isinstance(value, dict)
                if float(value["created_at"]) >= cutoff
            ][-self._config.queue_capacity :]
            for item in loaded:
                UUID(item.queue_id)
                if (
                    not isinstance(item.attempts, int)
                    or isinstance(item.attempts, bool)
                    or item.attempts < 0
                    or item.attempts > self._config.max_retries
                    or not isinstance(item.created_at, (int, float))
                    or not isinstance(item.next_attempt_at, (int, float))
                    or isinstance(item.created_at, bool)
                    or isinstance(item.next_attempt_at, bool)
                    or not math.isfinite(item.created_at)
                    or not math.isfinite(item.next_attempt_at)
                ):
                    raise ValueError("invalid persistent queue metadata")
                self._policy.validate_persisted_request(item.request)
                payload = item.request.get("payload")
                request_name = payload.get("name") if isinstance(payload, dict) else None
                if item.event_name != request_name:
                    raise ValueError("persistent queue event name mismatch")
            with self._lock:
                self._queue.extend(loaded)
        except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            self._emit(Diagnostic("transport_permanent_failure", detail="queue_corrupt"))

    def _delete_persistent_queue(self) -> None:
        path = self._config.persistent_queue_path
        if path is None:
            return
        try:
            path.resolve().unlink(missing_ok=True)
        except OSError:
            self._emit(Diagnostic("transport_retryable_failure", detail="queue_delete"))

    def _emit(self, diagnostic: Diagnostic) -> None:
        try:
            if self._config.on_diagnostic:
                self._config.on_diagnostic(diagnostic)
        except Exception:
            pass

    def _reset_transport_session(self) -> None:
        try:
            reset = getattr(self._transport, "reset_session", None)
            if reset is not None:
                reset()
        except Exception:
            pass
